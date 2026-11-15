import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, copyFileSync, createReadStream, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { githubFetch } from "../github-fetch";
import { createChildProcessEnvironment } from "../project-command-env";
import { isUpdateDisabled } from "../update-policy";
import { resolveOmpBin, versionFingerprint, wrapWindowsScript } from "./omp-cli";
import type { OmpUpdateStatus } from "./updates";

const CUSTOM_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-int\.([a-f0-9]{7})$/;
const MAX_BINARY = 256 * 1024 * 1024;
const GITHUB_HOSTS: Record<string, true> = {
  "api.github.com": true,
  "github.com": true,
  "release-assets.githubusercontent.com": true,
  "objects.githubusercontent.com": true,
  "raw.githubusercontent.com": true,
};

/** Only a GitHub owner/repository, never a URL or a filesystem path. */
export function validateCustomOmpRepository(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 140 || value.trim() !== value) return false;
  const parts = value.split("/");
  return parts.length === 2
    && /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(parts[0]) && !parts[0].includes("--")
    && /^[a-z0-9._-]{1,100}$/i.test(parts[1]) && parts[1] !== "." && parts[1] !== "..";
}

function canonicalVersion(value: unknown): string {
  if (typeof value !== "string" || value.length > 100 || value.trim() !== value) throw new Error("Invalid custom OMP release tag");
  const version = value.replace(/^v/, "");
  if (!CUSTOM_VERSION.test(version)) throw new Error("Invalid custom OMP release tag");
  return version;
}

function assertRepository(repository: string): void {
  if (!validateCustomOmpRepository(repository)) throw new Error("Invalid custom OMP repository (expected owner/repo)");
}

class ReleaseHttpError extends Error {
  constructor(readonly status: number) { super(`Custom OMP release request failed (${status})`); }
}

function githubUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !Object.hasOwn(GITHUB_HOSTS, url.hostname) || url.port || url.username || url.password) throw new Error("Unexpected GitHub release download destination");
  return url;
}

async function fetchBytes(input: string, maxBytes: number, token?: string, timeout = 15_000): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let url = githubUrl(input);
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await githubFetch(url, { signal: controller.signal, cache: "no-store", redirect: "manual", headers: { "User-Agent": "ompweb-omp-updater" } }, token);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects === 5) throw new Error("Too many or invalid GitHub release redirects");
        url = githubUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new ReleaseHttpError(response.status);
      }
      if (response.url) githubUrl(response.url);
      if (Number(response.headers.get("content-length")) > maxBytes) {
        await response.body.cancel();
        throw new Error("Custom OMP release response is too large");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > maxBytes) throw new Error("Custom OMP release response is too large");
          chunks.push(item.value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      return Buffer.concat(chunks, size);
    }
    throw new Error("Too many GitHub release redirects");
  } finally { clearTimeout(timer); }
}

async function releaseTag(repository: string, endpoint: string, token?: string): Promise<string> {
  const release: unknown = JSON.parse((await fetchBytes(`https://api.github.com/repos/${repository}/releases/${endpoint}`, 2 * 1024 * 1024, token)).toString("utf8"));
  if (!release || typeof release !== "object" || !("tag_name" in release)) throw new Error("Invalid custom OMP release metadata");
  canonicalVersion(release.tag_name);
  return release.tag_name as string;
}

function ompBinary(): string | null {
  // An explicit override must win even when the shared resolver cached an earlier PATH hit.
  const binary = process.env.OMP_WEB_OMP_BIN || resolveOmpBin();
  return binary ? resolve(binary) : null;
}

function runBinary(binary: string, args: string[], timeout: number): Promise<string> {
  const target = wrapWindowsScript(binary, args);
  const { promise, resolve: resolveOutput, reject } = Promise.withResolvers<string>();
  execFile(target.file, target.args, { timeout, maxBuffer: 1024 * 1024, windowsHide: true, env: createChildProcessEnvironment({ FORCE_COLOR: "0", NO_COLOR: "1" }) }, (error, stdout, stderr) => {
    if (error) reject(new Error(`OMP ${args[0]} failed: ${(stderr || stdout || error.message).trim().slice(-1000)}`));
    else resolveOutput(stdout.trim());
  });
  return promise;
}

async function binaryDigest(binary: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(binary)) hash.update(bytes);
  return hash.digest("hex");
}

async function installedVersion(binary: string | null): Promise<string | null> {
  if (!binary) return null;
  try {
    const fingerprint = versionFingerprint(binary);
    const output = await runBinary(binary, ["--version"], 10_000);
    const version = output.match(/(?:^|[\s/])v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-int\.[a-f0-9]{7})?)(?=$|[\s(])/m)?.[1] ?? null;
    if (!version) return null;
    try {
      const executable = realpathSync(binary);
      const metadataPath = `${executable}.build.json`;
      const stat = lstatSync(metadataPath);
      if (!stat.isFile() || stat.size > 16 * 1024) return version;
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { tag?: unknown; buildSha?: unknown; sha256?: unknown };
      const tag = canonicalVersion(metadata.tag);
      if (tag.split("-int.")[0] === version && metadata.buildSha === tag.split("-int.")[1]
        && typeof metadata.sha256 === "string" && /^[a-f0-9]{64}$/.test(metadata.sha256)
        && await binaryDigest(executable) === metadata.sha256 && versionFingerprint(binary) === fingerprint) return tag;
    } catch { /* A stale/missing sidecar cannot identify a different executable as this build. */ }
    return versionFingerprint(binary) === fingerprint ? version : null;
  } catch { return null; }
}

export async function checkCustomOmpUpdate(repository: string, token?: string): Promise<OmpUpdateStatus> {
  assertRepository(repository);
  const updateCommand = `Custom OMP release (${repository})`;
  if (isUpdateDisabled()) return { currentVersion: null, availableVersion: null, updateAvailable: false, updateCommand, updatesDisabled: true };
  const [currentVersion, tag] = await Promise.all([installedVersion(ompBinary()), releaseTag(repository, "latest", token)]);
  const availableVersion = canonicalVersion(tag);
  return { currentVersion, availableVersion, updateAvailable: currentVersion !== availableVersion, updateCommand };
}

interface Installation {
  binary: string;
  executable: string;
  root: string;
  current?: string;
}

function installation(binary: string): Installation {
  const executable = realpathSync(binary);
  if (!lstatSync(executable).isFile()) throw new Error("OMP executable is not a regular file");
  let path = binary;
  for (let links = 0; links < 20; links++) {
    for (let ancestor = dirname(path); dirname(ancestor) !== ancestor; ancestor = dirname(ancestor)) {
      if (basename(ancestor) !== "current" || !lstatSync(ancestor).isSymbolicLink()) continue;
      const root = realpathSync(dirname(ancestor));
      const current = join(root, "current");
      const release = realpathSync(current);
      if (dirname(release) !== join(root, "releases") || dirname(executable) !== release || !["omp", "omp.exe"].includes(basename(executable))) throw new Error("Unsafe OMP current symlink layout");
      return { binary, executable, root, current };
    }
    if (!lstatSync(path).isSymbolicLink()) return { binary, executable, root: dirname(executable) };
    const target = readlinkSync(path);
    path = isAbsolute(target) ? target : resolve(dirname(path), target);
  }
  throw new Error("Too many OMP executable symlinks");
}

function assertOwnedDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o022) !== 0)) throw new Error("Unsafe or unowned OMP update directory");
}

function sameEntry(path: string, stat: Stats): boolean {
  try {
    const current = lstatSync(path);
    return current.dev === stat.dev && current.ino === stat.ino && !current.isSymbolicLink();
  } catch { return false; }
}

function assetName(): string {
  if (!["linux", "darwin", "win32"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) throw new Error(`Custom OMP updates are unsupported on ${process.platform}/${process.arch}`);
  return `omp-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
}

/** Stage and smoke-test before publishing; never reuse a release directory from another attempt. */
export async function runCustomOmpUpdate(repository: string, version: string, token?: string): Promise<void> {
  assertRepository(repository);
  const canonical = canonicalVersion(version);
  if (isUpdateDisabled()) throw new Error("Updates are disabled");
  const name = assetName();
  const binary = ompBinary();
  if (!binary) throw new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN.");
  const install = installation(binary);
  assertOwnedDirectory(install.root);
  const fingerprint = versionFingerprint(binary);
  const lockPath = join(install.root, ".omp-custom-update.lock");
  let lock: number;
  try { lock = openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("A custom OMP update is already in progress (update lock exists)");
    throw error;
  }
  const lockStat = fstatSync(lock);
  let release: string | undefined;
  let ownedRelease: Stats | undefined;
  const temporary = join(install.root, `.omp-update-${randomUUID()}`);
  let temporaryCreated = false;
  let temporaryMetadataCreated = false;
  let installed = false;
  try {
    let tag: string;
    try { tag = await releaseTag(repository, `tags/v${canonical}`, token); }
    catch (error) {
      if (!(error instanceof ReleaseHttpError) || error.status !== 404) throw error;
      tag = await releaseTag(repository, `tags/${canonical}`, token);
    }
    if (canonicalVersion(tag) !== canonical) throw new Error("Custom OMP release tag does not match the requested version");
    const base = `https://github.com/${repository}/releases/download/${tag}`;
    const sums = (await fetchBytes(`${base}/SHA256SUMS.txt`, 1024 * 1024, token)).toString("utf8");
    const matches = sums.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^([a-fA-F0-9]{64}) [ *](\S+)$/);
      return match?.[2] === name ? [match[1].toLowerCase()] : [];
    });
    if (matches.length !== 1) throw new Error("Custom OMP checksum is missing or ambiguous");
    const bytes = await fetchBytes(`${base}/${name}`, MAX_BINARY, token, 120_000);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== matches[0]) throw new Error("Custom OMP release digest mismatch");
    const releases = join(install.root, "releases");
    try { mkdirSync(releases, { mode: 0o755 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    assertOwnedDirectory(releases);
    release = join(releases, tag);
    mkdirSync(release, { mode: 0o755 });
    ownedRelease = lstatSync(release);
    const staged = join(release, process.platform === "win32" ? "omp.exe" : "omp");
    writeFileSync(staged, bytes, { mode: 0o755, flag: "wx" });
    const metadata = JSON.stringify({ tag: canonical, buildSha: canonical.split("-int.")[1], sha256 });
    writeFileSync(`${staged}.build.json`, metadata, { mode: 0o644, flag: "wx" });
    await runBinary(staged, ["--smoke-test"], 60_000);
    if (versionFingerprint(binary) !== fingerprint || !sameEntry(release, ownedRelease)) throw new Error("OMP installation changed during the update");
    if (install.current) {
      symlinkSync(`releases/${tag}`, temporary, process.platform === "win32" ? "junction" : "dir");
      temporaryCreated = true;
      renameSync(temporary, install.current);
    } else {
      copyFileSync(staged, temporary, constants.COPYFILE_EXCL);
      temporaryCreated = true;
      writeFileSync(`${temporary}.build.json`, metadata, { mode: 0o644, flag: "wx" });
      temporaryMetadataCreated = true;
      // The digest-bound sidecar goes first: a failed final rename leaves the old executable runnable.
      renameSync(`${temporary}.build.json`, `${install.executable}.build.json`);
      temporaryMetadataCreated = false;
      renameSync(temporary, install.executable);
    }
    temporaryCreated = false;
    installed = true;
  } finally {
    if (temporaryCreated) { try { unlinkSync(temporary); } catch { /* Retain the original install error. */ } }
    if (temporaryMetadataCreated) { try { unlinkSync(`${temporary}.build.json`); } catch { /* Retain the original install error. */ } }
    if (!installed && release && ownedRelease && sameEntry(release, ownedRelease)) {
      try { rmSync(release, { recursive: true }); } catch { /* Never replace the original failure with cleanup. */ }
    }
    try { closeSync(lock); } catch { /* Cleanup must not turn a published update into a reported failure. */ }
    if (sameEntry(lockPath, lockStat)) { try { unlinkSync(lockPath); } catch { /* A remaining lock fails future attempts closed. */ } }
  }
}
