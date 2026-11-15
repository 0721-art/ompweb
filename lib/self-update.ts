import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
  type Stats,
} from "fs";
import { execFile, spawn } from "child_process";
import { createChildProcessEnvironment, isHostRuntimeVariable, isOmpWebSecretVariable } from "./project-command-env";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { dirname, join, posix, resolve, win32 } from "path";
import { promisify } from "util";
import { checkNpmUpdate, detectInstallMethod } from "./npm-update";
import { DISABLE_AUTOUPDATE_ENV_VAR, isUpdateDisabled } from "./update-policy";
import { checkPrereleaseUpdate, resolveOmpwebReleaseSha } from "./ompweb-releases";
import { processStartIdentity, stageBinary } from "./hosts/update-worker";
import { parseLaunchOptions } from "../bin/omp-web-options";
import { releaseRepo } from "./release-repo";

const LEASE_MS = 30 * 60 * 1000;
const TERMINAL_STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const execFileAsync = promisify(execFile);

export type SelfUpdateState = "prepared" | "running" | "succeeded" | "failed";
export type SelfUpdateStage = "preparing" | "stopping" | "installing" | "restarting" | "finalizing";
export interface SelfUpdateStatus {
  attemptId: string;
  state: SelfUpdateState;
  stage?: SelfUpdateStage;
  fromVersion: string;
  targetVersion: string;
  preparedAt: string;
  startedAt?: string;
  finishedAt?: string;
  recovered?: boolean;
  error?: string;
  cleanupReady?: boolean;
}
interface StoredStatus extends SelfUpdateStatus {
  workerPid?: number;
  managerPid?: number;
  deploy?: boolean;
  binaryWorker?: boolean;
}
export interface PrepareResult {
  attemptId: string;
  targetVersion: string;
}
export class SelfUpdateError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 400) {
    super(message);
    this.name = "SelfUpdateError";
  }
}

export interface SelfUpdateOptions {
  channel?: "stable" | "prerelease";
  token?: string;
}

const updateTokens = new Map<string, string>();

function assertUpdatesEnabled(): void {
  if (!isUpdateDisabled()) return;
  throw new SelfUpdateError("updates_disabled", `Updates are disabled by ${DISABLE_AUTOUPDATE_ENV_VAR}`, 403);
}

export function resolveSelfUpdateTempRoot(
  platform: NodeJS.Platform = process.platform,
  temporary = tmpdir(),
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
): string {
  const pathApi = platform === "win32" ? win32 : posix;
  const suffix = platform === "win32" ? "" : `-${uid ?? "user"}`;
  // Canonicalize only the temp ancestor; the update root itself must still reject symlinks.
  if (platform === process.platform && existsSync(temporary)) temporary = realpathSync(temporary);
  return pathApi.join(temporary, `ompweb-self-update${suffix}`);
}

function rootDir(): string {
  return resolveSelfUpdateTempRoot();
}
function leasePath(): string {
  return join(rootDir(), "lease.json");
}
function statusPath(): string {
  return join(rootDir(), "status.json");
}
function markerPath(attemptId: string, marker: string): string {
  return join(rootDir(), `${attemptId}.${marker}`);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT");
}
function isBusy(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(String((error as { code: string }).code)));
}
function ownedByCurrentUser(info: Stats): boolean {
  return process.platform === "win32" || typeof process.getuid !== "function" || info.uid === process.getuid();
}
function secureDirectory(path: string): Stats {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !ownedByCurrentUser(info)) {
    throw new SelfUpdateError("unsafe_update_state", "The temporary update state path is unsafe", 500);
  }
  return info;
}
function secureRegularFile(path: string): Stats | null {
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !ownedByCurrentUser(info)) {
    throw new SelfUpdateError("unsafe_update_state", "The temporary update state contains an unsafe file", 500);
  }
  return info;
}
function atomicWrite(path: string, value: string): void {
  secureDirectory(dirname(path));
  secureRegularFile(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
function readStateJson<T>(path: string): T | null {
  if (!secureRegularFile(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
function ensureSecureRoot(create: boolean): string | null {
  const root = rootDir();
  if (!existsSync(root)) {
    if (!create) return null;
    try {
      mkdirSync(root, { mode: 0o700, recursive: true });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "EEXIST")) throw error;
    }
  }
  secureDirectory(root);
  try {
    chmodSync(root, 0o700);
  } catch {
    // Windows
  }
  return root;
}
function attemptsDir(create: boolean): string | null {
  const root = ensureSecureRoot(create);
  if (!root) return null;
  const attempts = join(root, "attempts");
  if (!existsSync(attempts)) {
    if (!create) return null;
    try {
      mkdirSync(attempts, { mode: 0o700 });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "EEXIST")) throw error;
    }
  }
  secureDirectory(attempts);
  return attempts;
}
function isActiveLease(lease: { expiresAt?: unknown } | null, now = Date.now()): boolean {
  if (!lease || typeof lease.expiresAt !== "number" || !Number.isFinite(lease.expiresAt)) return false;
  // Reject absurd future timestamps (tampered lease) — allow at most LEASE_MS + 5m skew.
  if (lease.expiresAt > now + LEASE_MS + 5 * 60 * 1000) return false;
  return lease.expiresAt > now;
}
function isTerminalStatus(status: SelfUpdateStatus | null | undefined): boolean {
  return status?.state === "succeeded" || status?.state === "failed";
}
function isProcessAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
}
function removeSecureFile(path: string): boolean {
  if (!secureRegularFile(path)) return true;
  try {
    rmSync(path);
    return true;
  } catch (error) {
    if (isBusy(error)) return false;
    throw error;
  }
}
function removeSecureEmptyDirectory(path: string): boolean {
  try {
    secureDirectory(path);
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
  try {
    rmdirSync(path);
    return true;
  } catch (error) {
    if (isBusy(error)) return false;
    if (isMissing(error)) return true;
    throw error;
  }
}
function validateOwnedTree(path: string): void {
  const info = lstatSync(path);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    secureDirectory(path);
    for (const name of readdirSync(path)) validateOwnedTree(join(path, name));
  } else {
    secureRegularFile(path);
  }
}
function removeOwnedTree(path: string): boolean {
  const info = lstatSync(path);
  if (!info.isDirectory()) return removeSecureFile(path);
  for (const name of readdirSync(path)) {
    if (!removeOwnedTree(join(path, name))) return false;
  }
  return removeSecureEmptyDirectory(path);
}
function removeAttemptDirectory(attemptId: string): boolean {
  const attempts = attemptsDir(false);
  if (!attempts) return true;
  const dir = join(attempts, attemptId);
  try {
    secureDirectory(dir);
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
  const entries = readdirSync(dir);
  if (entries.some((entry) => !["worker.js", "worker", "worker.exe", "deploy.json", "staging"].includes(entry))) {
    throw new SelfUpdateError("unsafe_update_state", "The temporary update attempt contains unexpected files", 500);
  }
  // Validate the entire tree before deleting anything; never follow staged links.
  validateOwnedTree(dir);
  for (const name of entries) {
    if (!removeOwnedTree(join(dir, name))) return false;
  }
  return removeSecureEmptyDirectory(dir);
}
function removeAttemptArtifacts(attemptId: string, includeCompletionAck = true): boolean {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) return false;
  if (!removeAttemptDirectory(attemptId)) return false;
  const suffixes = ["ready", "go", "abort.json", "armed.json", "restart-request.json", "restart-ack.json", "complete.json"];
  if (includeCompletionAck) suffixes.push("complete-ack.json");
  for (const s of suffixes) {
    if (!removeSecureFile(markerPath(attemptId, s))) return false;
  }
  return true;
}
function pruneEmptyRoot(): void {
  const attempts = attemptsDir(false);
  if (attempts) removeSecureEmptyDirectory(attempts);
  const root = ensureSecureRoot(false);
  if (root) removeSecureEmptyDirectory(root);
}
export function cleanupStaleSelfUpdate(now = Date.now()): void {
  if (!ensureSecureRoot(false)) return;
  const status = readStateJson<StoredStatus>(statusPath());
  const lease = readStateJson<{ attemptId?: unknown; expiresAt?: unknown }>(leasePath());
  if (lease && !isActiveLease(lease, now)) {
    removeSecureFile(leasePath());
  }
  if (!status || typeof status.attemptId !== "string") {
    pruneEmptyRoot();
    return;
  }
  const timestamp = Date.parse(status.finishedAt ?? status.preparedAt);
  const currentLease = readStateJson<{ attemptId?: unknown; expiresAt?: unknown }>(leasePath());
  const leaseStillActive = isActiveLease(currentLease, now);
  if (
    Number.isFinite(timestamp) &&
    now - timestamp >= TERMINAL_STATUS_TTL_MS &&
    !leaseStillActive &&
    (isTerminalStatus(status) || !currentLease) &&
    !isProcessAlive(status.workerPid) &&
    !isProcessAlive(status.managerPid) &&
    removeAttemptArtifacts(status.attemptId)
  ) {
    removeSecureFile(statusPath());
  }
  pruneEmptyRoot();
}

const WORKER_LOST_ERROR = "The update worker stopped before the update finished";

function isWorkerLost(status: StoredStatus): boolean {
  if (status.state !== "running") return false;
  // The worker never outlives its lease, and a reused pid cannot keep an expired one alive.
  if (!isActiveLease(readStateJson<{ expiresAt?: unknown }>(leasePath()))) return true;
  return status.workerPid !== undefined && !isProcessAlive(status.workerPid);
}

export function getSelfUpdateStatus(): SelfUpdateStatus | null {
  const s = readStateJson<StoredStatus>(statusPath());
  if (!s) return null;
  // minimal validation
  if (typeof s.attemptId !== "string" || typeof s.state !== "string") return null;
  if (!isWorkerLost(s)) return s;
  // Re-read: the worker may have written its result just before it exited.
  const latest = readStateJson<StoredStatus>(statusPath());
  if (latest?.attemptId !== s.attemptId || latest.state !== "running") return latest;
  const failed: StoredStatus = { ...latest, state: "failed", error: WORKER_LOST_ERROR, finishedAt: new Date().toISOString(), cleanupReady: true };
  // A read must not fail over the write; the next poll retries it.
  try {
    atomicWrite(statusPath(), JSON.stringify(failed));
  } catch {}
  return failed;
}

export interface SystemdService {
  unit: string;
  user: boolean;
}

/** The systemd service named by `/proc/<pid>/cgroup` content, or null outside one. */
export function parseSystemdServiceCgroup(cgroup: string): SystemdService | null {
  for (const line of cgroup.split("\n")) {
    if (!line.startsWith("0::") && !line.includes(":name=systemd:")) continue;
    const segments = line.split(":").slice(2).join(":").trim().split("/");
    const unit = segments.at(-1);
    if (unit?.endsWith(".service")) {
      return { unit, user: segments.some((segment) => /^user@\d+\.service$/.test(segment)) };
    }
  }
  return null;
}

function commandError(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  return (typeof stderr === "string" && stderr.trim()) || (error instanceof Error ? error.message : String(error));
}

async function detectSystemdService(launcherPid: number): Promise<SystemdService | null> {
  if (process.platform !== "linux") return null;
  let service: SystemdService | null;
  try {
    service = parseSystemdServiceCgroup(readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    return null;
  }
  if (!service) return null;
  // Only the unit this launcher is the main process of: a dev server started
  // from a session inside another unit must never stop that unit.
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("systemctl", [...(service.user ? ["--user"] : []), "show", "--property=MainPID", "--value", service.unit], { encoding: "utf8", timeout: 5000 }));
  } catch (error) {
    // Guessing "not systemd" would start a worker the unit's stop kills.
    throw new Error(`Cannot check systemd unit ${service.unit}: ${commandError(error)}`);
  }
  return Number(stdout.trim()) === launcherPid ? service : null;
}
export function getSelfUpdateSupport(): { supported: boolean; reason?: string; packageDir: string } {
  const packageDir = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd();
  if (isUpdateDisabled()) {
    return { supported: false, reason: `Updates are disabled by ${DISABLE_AUTOUPDATE_ENV_VAR}`, packageDir };
  }
  try {
    if (!existsSync(packageDir)) return { supported: false, reason: "package dir not found", packageDir };
    return { supported: true, packageDir: resolve(packageDir) };
  } catch {
    return { supported: false, reason: "unsupported", packageDir };
  }
}

function detectManager(packageDir: string): { manager: "npm" | "bun"; managerPath: string; prefix: string[] } {
  const manager = detectInstallMethod(packageDir);
  const managerPath = manager === "bun" ? "bun" : "npm";
  return { manager, managerPath, prefix: [] };
}

export async function prepareSelfUpdate(options: SelfUpdateOptions = {}): Promise<PrepareResult> {
  assertUpdatesEnabled();
  const channel = options.channel ?? "stable";
  const deploy = Boolean(process.env.OMP_WEB_SELF_UPDATE_CMD);
  const binary = Bun.isStandaloneExecutable || deploy;
  if (channel === "prerelease" && !binary) {
    throw new SelfUpdateError("self_update_unsupported", "Pre-release binary updates require OMP_WEB_SELF_UPDATE_CMD for package installations", 409);
  }
  cleanupStaleSelfUpdate(Date.now());
  ensureSecureRoot(true);
  const leaseFile = leasePath();
  const statusFile = statusPath();
  const existingLease = readStateJson<{ attemptId?: string; expiresAt?: number }>(leaseFile);
  if (isActiveLease(existingLease)) {
    throw new SelfUpdateError("update_in_progress", "Another update is already in progress", 409);
  }
  const update = channel === "prerelease"
    ? await checkPrereleaseUpdate(true, options.token)
    : await checkNpmUpdate(true);
  if (!update.updateAvailable || !update.availableVersion) {
    throw new SelfUpdateError("no_update_available", "No update available", 409);
  }
  const targetVersion = update.availableVersion;
  const releaseTag = channel === "prerelease" ? targetVersion : `v${targetVersion}`;
  const releaseSha = binary
    ? ("releaseSha" in update && update.releaseSha) || await resolveOmpwebReleaseSha(releaseTag, options.token)
    : undefined;
  const attemptId = randomUUID();
  const preparedAt = new Date().toISOString();
  atomicWrite(leaseFile, JSON.stringify({ attemptId, expiresAt: Date.now() + LEASE_MS, preparedAt }));
  const stored: StoredStatus = {
    attemptId,
    state: "prepared",
    fromVersion: update.currentVersion,
    targetVersion,
    preparedAt,
    deploy: deploy || undefined,
    binaryWorker: Bun.isStandaloneExecutable || undefined,
  };
  atomicWrite(statusFile, JSON.stringify(stored));
  const attempts = attemptsDir(true)!;
  const attemptDir = join(attempts, attemptId);
  mkdirSync(attemptDir, { mode: 0o700, recursive: true });
  secureDirectory(attemptDir);
  const packageDir = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd();
  const workerSrc = stored.binaryWorker ? process.execPath : join(packageDir, "bin", "omp-web-update-worker.js");
  const destWorker = join(attemptDir, stored.binaryWorker ? (process.platform === "win32" ? "worker.exe" : "worker") : "worker.js");
  try {
    if (binary) {
      const staging = join(attemptDir, "staging");
      mkdirSync(staging, { mode: 0o700 });
      const directory = await stageBinary({ version: targetVersion, channel, releaseRepo: releaseRepo(), releaseTag, releaseSha, token: options.token }, staging);
      const restart = stored.binaryWorker && !deploy ? {
        binaryPath: realpathSync(process.execPath),
        binaryArgs: process.argv.slice(2),
        cwd: process.cwd(),
        pid: process.pid,
        identity: await processStartIdentity(process.pid),
      } : undefined;
      atomicWrite(join(attemptDir, "deploy.json"), JSON.stringify({ attemptId, sha: releaseSha, directory, restart }));
    }
    copyFileSync(workerSrc, destWorker);
    chmodSync(destWorker, stored.binaryWorker ? 0o700 : 0o600);
  } catch (error) {
    atomicWrite(statusFile, JSON.stringify({ ...stored, state: "failed", error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString(), cleanupReady: true }));
    removeSecureFile(leaseFile);
    throw error;
  }
  if (options.token) updateTokens.set(attemptId, options.token);
  atomicWrite(markerPath(attemptId, "ready"), JSON.stringify({ attemptId, preparedAt }));
  return { attemptId, targetVersion };
}

export function validateCommitSelfUpdate(attemptId: string): "ready" | "replay" {
  assertUpdatesEnabled();
  const status = readStateJson<StoredStatus>(statusPath());
  if (!status || status.attemptId !== attemptId) throw new SelfUpdateError("attempt_not_found", "Update attempt not found", 404);
  if (status.state === "running") return "replay";
  if (status.state !== "prepared") throw new SelfUpdateError("invalid_state", "Update attempt is not prepared", 409);
  const lease = readStateJson<{ attemptId?: string; expiresAt?: unknown }>(leasePath());
  if (!lease || lease.attemptId !== attemptId) throw new SelfUpdateError("lease_mismatch", "Lease mismatch", 409);
  if (!isActiveLease(lease)) throw new SelfUpdateError("lease_expired", "Update attempt expired; prepare it again", 409);
  if (!existsSync(markerPath(attemptId, "ready"))) throw new SelfUpdateError("not_ready", "Update attempt not ready", 409);
  return "ready";
}
export function markSelfUpdateStopping(attemptId: string): void {
  const status = readStateJson<StoredStatus>(statusPath());
  if (!status || status.attemptId !== attemptId) return;
  // The worker gets a full lease from here: a running attempt past it counts as lost.
  const lease = readStateJson<Record<string, unknown>>(leasePath());
  // Never take over another attempt's lease.
  if (lease?.attemptId === attemptId) {
    atomicWrite(leasePath(), JSON.stringify({ ...lease, expiresAt: Date.now() + LEASE_MS }));
  }
  const next: StoredStatus = { ...status, state: "running", stage: "stopping", startedAt: new Date().toISOString() };
  atomicWrite(statusPath(), JSON.stringify(next));
}

export async function armSelfUpdateLauncher(attemptId: string): Promise<void> {
  const armed = markerPath(attemptId, "armed.json");
  atomicWrite(armed, JSON.stringify({ attemptId, armedAt: new Date().toISOString(), protocol: 1 }));
  // settle
  await new Promise<void>((r) => setTimeout(r, 500));
}

export async function commitSelfUpdate(attemptId: string): Promise<{ accepted: true; attemptId: string }> {
  assertUpdatesEnabled();
  const status = readStateJson<StoredStatus>(statusPath());
  if (!status || status.attemptId !== attemptId) throw new SelfUpdateError("attempt_not_found", "Update attempt not found", 404);
  // write go marker
  atomicWrite(markerPath(attemptId, "go"), JSON.stringify({ attemptId, committedAt: new Date().toISOString(), protocol: 1 }));
  // update status to running if not already
  if (status.state === "prepared") {
    const next: StoredStatus = { ...status, state: "running", stage: "preparing", startedAt: new Date().toISOString() };
    atomicWrite(statusPath(), JSON.stringify(next));
  }
  // spawn worker detached
  const attempts = attemptsDir(false);
  const workerName = status.binaryWorker ? (process.platform === "win32" ? "worker.exe" : "worker") : "worker.js";
  const workerPath = attempts ? join(attempts, attemptId, workerName) : null;
  const root = rootDir();
  const packageDir = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd();
  const { manager, managerPath, prefix } = status.binaryWorker || status.deploy
    ? { manager: "npm" as const, managerPath: "", prefix: [] }
    : detectManager(packageDir);
  const launcherPid = status.binaryWorker ? process.pid : Number(process.env.OMP_WEB_LAUNCHER_PID ?? process.pid);
  const listen = status.binaryWorker ? parseLaunchOptions() : null;
  const descriptor = {
    ...(!status.binaryWorker ? { launcherPath: join(resolve(packageDir), "bin", "omp-web.js") } : {}),
    hostname: listen?.hostname ?? process.env.OMP_WEB_HOSTNAME ?? process.env.HOSTNAME ?? "127.0.0.1",
    port: Number(listen?.port ?? process.env.OMP_WEB_PORT ?? process.env.PORT ?? 30178),
  };
  const args = [
    workerPath ?? "",
    "--attempt",
    attemptId,
    "--root",
    root,
    "--package-dir",
    resolve(packageDir),
    "--manager",
    manager,
    "--manager-path",
    managerPath,
    "--target",
    status.targetVersion,
    "--from",
    status.fromVersion,
    "--launcher-pid",
    String(launcherPid),
    "--server-pid",
    String(process.pid),
    "--descriptor",
    JSON.stringify(descriptor),
    "--manager-prefix",
    JSON.stringify(prefix),
  ];
  if ((status.deploy || status.binaryWorker) && attempts) {
    args.push(status.deploy ? "--deploy-descriptor" : "--binary-descriptor", join(attempts, attemptId, "deploy.json"));
  }
  try {
    const systemd = await detectSystemdService(launcherPid);
    if (systemd) args.push("--systemd-unit", systemd.unit, "--systemd-user", systemd.user ? "1" : "0");
    const workerArgs = status.binaryWorker ? ["self-update-worker", ...args.slice(1)] : args;
    const runtime = status.binaryWorker ? workerPath! : process.env.OMP_WEB_NODE_BIN || process.execPath;
    let command = runtime;
    let commandArgs = workerArgs;
    if (systemd) {
      // A worker left in the unit's cgroup is killed with the server it stops,
      // so it runs in its own transient scope.
      const systemdRun = [...(systemd.user ? ["--user"] : []), "--scope", "--quiet", "--collect", "--no-ask-password"];
      try {
        await execFileAsync("systemd-run", [...systemdRun, "true"], { encoding: "utf8", timeout: 10000 });
      } catch (error) {
        throw new Error(`systemd-run cannot start the update worker: ${commandError(error)}`);
      }
      command = "systemd-run";
      commandArgs = [...systemdRun, runtime, ...workerArgs];
    }
    const token = updateTokens.get(attemptId);
    const child = spawn(command, commandArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: createChildProcessEnvironment({
        OMP_WEB_SELF_UPDATE_CMD: status.deploy ? process.env.OMP_WEB_SELF_UPDATE_CMD : undefined,
        OMP_WEB_UPDATE_GITHUB_TOKEN: token,
        OMP_WEB_BINARY_RESTART_ENV: status.binaryWorker && !status.deploy
          ? JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => isHostRuntimeVariable(name) || isOmpWebSecretVariable(name))))
          : undefined,
      }),
    });
    updateTokens.delete(attemptId);
    // A failed launch arrives as an event, after this function returned.
    child.once("error", (error) => {
      const current = readStateJson<StoredStatus>(statusPath());
      if (current?.attemptId !== attemptId || current.state !== "running") return;
      try {
        atomicWrite(statusPath(), JSON.stringify({ ...current, state: "failed", error: error.message.slice(0, 240), finishedAt: new Date().toISOString(), cleanupReady: true }));
      } catch {}
    });
    child.unref();
    // record worker pid
    const updated: StoredStatus = { ...readStateJson<StoredStatus>(statusPath())!, workerPid: child.pid };
    try {
      atomicWrite(statusPath(), JSON.stringify(updated));
    } catch {}
  } catch (error) {
    updateTokens.delete(attemptId);
    const failed: StoredStatus = { ...status, state: "failed", error: error instanceof Error ? error.message.slice(0, 240) : String(error), finishedAt: new Date().toISOString(), cleanupReady: true };
    try {
      atomicWrite(statusPath(), JSON.stringify(failed));
    } catch {}
    throw new SelfUpdateError("spawn_failed", "Failed to spawn update worker", 500);
  }
  return { accepted: true, attemptId };
}

export async function abortPreparedSelfUpdate(attemptId: string, reason: string): Promise<void> {
  try {
    atomicWrite(markerPath(attemptId, "abort.json"), JSON.stringify({ attemptId, reason, protocol: 1 }));
  } catch {}
  updateTokens.delete(attemptId);
  const status = readStateJson<StoredStatus>(statusPath());
  if (status && status.attemptId === attemptId && status.state === "prepared") {
    const next: StoredStatus = { ...status, state: "failed", error: reason.slice(0, 240), finishedAt: new Date().toISOString(), cleanupReady: true };
    try {
      atomicWrite(statusPath(), JSON.stringify(next));
    } catch {}
  }
}

export function acknowledgeSelfUpdate(attemptId: string): { acknowledged: true; attemptId: string } {
  if (!ensureSecureRoot(false)) throw new SelfUpdateError("attempt_not_terminal", "The update attempt is not ready for cleanup", 409);
  const status = readStateJson<StoredStatus>(statusPath());
  if (status?.attemptId !== attemptId || (status.state !== "succeeded" && status.state !== "failed")) {
    throw new SelfUpdateError("attempt_not_terminal", "The update attempt is not ready for cleanup", 409);
  }
  const lease = readStateJson<{ attemptId?: unknown; expiresAt?: unknown }>(leasePath());
  if (isProcessAlive(status.workerPid) || isProcessAlive(status.managerPid) || (lease && (lease as { attemptId?: string }).attemptId !== attemptId)) {
    throw new SelfUpdateError("cleanup_not_ready", "The update is still finishing cleanup", 409);
  }
  // remove artifacts
  if (!removeAttemptArtifacts(attemptId)) {
    throw new SelfUpdateError("cleanup_not_ready", "The update is still finishing cleanup", 409);
  }
  // release lease
  if (lease && (lease as { attemptId?: string }).attemptId === attemptId) {
    removeSecureFile(leasePath());
  }
  removeSecureFile(statusPath());
  updateTokens.delete(attemptId);
  pruneEmptyRoot();
  return { acknowledged: true, attemptId };
}
