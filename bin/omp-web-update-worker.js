#!/usr/bin/env node
"use strict";
// Dependency-free CommonJS - copied outside pkgDir to survive Windows file-lock
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cp = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const net = require("node:net");

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const STAGES = ["preparing", "stopping", "installing", "restarting", "finalizing"];

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
const attemptId = arg("--attempt");
const root = arg("--root");
const packageDir = arg("--package-dir");
const manager = arg("--manager");
const managerPath = arg("--manager-path");
const target = arg("--target");
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const from = arg("--from");
const launcherPid = Number(arg("--launcher-pid"));
const serverPid = Number(arg("--server-pid"));
const kind = arg("--kind") || "app";
const deployDescriptor = arg("--deploy-descriptor");
const binaryDescriptor = arg("--binary-descriptor");
let binaryRestart;
let restartedBinary;
const binaryEnvironment = JSON.parse(process.env.OMP_WEB_BINARY_RESTART_ENV || "{}");
delete process.env.OMP_WEB_BINARY_RESTART_ENV;
// Set when the server runs as this systemd unit; systemd stops and starts it.
const systemdUnit = arg("--systemd-unit");
const systemctlScope = arg("--systemd-user") === "1" ? ["--user"] : [];
let descriptor;
let managerPrefix;
try {
  descriptor = JSON.parse(arg("--descriptor") || "null");
  managerPrefix = JSON.parse(arg("--manager-prefix") || "[]");
} catch {
  descriptor = null;
  managerPrefix = [];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function leaseFile() { return path.join(root, "lease.json"); }
function statusFile() { return path.join(root, "status.json"); }
function markerFile(m) { return path.join(root, attemptId + "." + m); }
function abortFile() { return markerFile("abort.json"); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function atomicWrite(file, obj) {
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj), { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}
function updateStatus(patch) {
  const cur = readJson(statusFile()) || {};
  const next = { ...cur, ...patch };
  // atomic write via tmp+rename
  const dir = path.dirname(statusFile());
  const tmp = path.join(dir, ".status." + process.pid + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(next), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, statusFile());
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isLaunchdActive() {
  try {
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", "com.kahme247.ompweb.plist");
    return fs.existsSync(plist);
  } catch { return false; }
}
function isTrayActive() {
  try {
    const svc = path.join(os.homedir(), ".omp", "agent", "web-service.json");
    if (!fs.existsSync(svc)) return false;
    const data = readJson(svc);
    return Boolean(data && data.pid);
  } catch { return false; }
}
function systemctl(action) {
  const result = cp.spawnSync("systemctl", [...systemctlScope, action, systemdUnit], { encoding: "utf8", timeout: 120000 });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || (result.error && result.error.message) || "").trim().slice(0, 200);
    throw new Error(`systemctl ${action} ${systemdUnit} failed${detail ? `: ${detail}` : ""}`);
  }
}

async function stopOriginalProcesses() {
  updateStatus({ stage: "stopping" });
  if (binaryRestart) return stopOriginalBinary();
  if (systemdUnit) {
    systemctl("stop");
    return { systemd: true, launchd: false, tray: false };
  }
  // Detect services
  const launchd = !binaryDescriptor && isLaunchdActive();
  const tray = !binaryDescriptor && isTrayActive();
  if (launchd) {
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : 501;
      cp.spawnSync("launchctl", ["bootout", `gui/${uid}/com.kahme247.ompweb`], { timeout: 15000, windowsHide: true });
    } catch {}
    await sleep(500);
  }
  if (tray) {
    try {
      const trayBin = path.join(packageDir, "bin", "omp-web-tray.js");
      if (fs.existsSync(trayBin)) {
        cp.spawnSync(process.execPath, [trayBin, "--stop"], { timeout: 15000, windowsHide: true });
      }
    } catch {}
    await sleep(500);
  }
  // Plain next: try to kill launcher/server pids with SIGTERM 5s -> SIGKILL
  if (!launchd && !tray) {
    for (const pid of [launcherPid, serverPid]) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    await sleep(5000);
    for (const pid of [launcherPid, serverPid]) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
    }
    // waitForPort 90s simplified: sleep 1s (real impl would poll port)
    await sleep(1000);
  }
  return { launchd, tray };
}

async function runManagerGate() {
  updateStatus({ stage: "installing" });
  if (kind === "omp") {
    // Run omp update
    const bin = process.env.OMP_WEB_OMP_BIN || "omp";
    // Try resolve via packageDir/../?
    await new Promise((resolve) => {
      const child = cp.spawn(bin, ["update"], { timeout: 5 * 60 * 1000, windowsHide: true, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 5 * 60 * 1000 + 1000);
    });
    return;
  }
  // App update via npm/bun
  const cmd = manager === "bun" ? (managerPath || "bun") : (managerPath || "npm");
  const args = manager === "bun" ? ["add", "-g", `@kahme247/ompweb@${target}`] : ["install", "-g", `@kahme247/ompweb@${target}`];
  if (Array.isArray(managerPrefix) && managerPrefix.length) args.unshift(...managerPrefix);
  let retries = 0;
  let lastResult;
  while (retries <= 1) {
    const result = cp.spawnSync(cmd, args, { timeout: 5 * 60 * 1000, windowsHide: true, env: process.env, shell: process.platform === "win32" });
    lastResult = result;
    const stderr = result.stderr ? result.stderr.toString() : "";
    const spawnError = result.error ? String(result.error.code || result.error.message || "") : "";
    const isBusy = (result.error && ["EBUSY", "EPERM"].includes(result.error.code || "")) || /EBUSY|EPERM/.test(stderr) || /EBUSY|EPERM/.test(spawnError);
    if (isBusy && retries === 0) {
      retries++;
      await sleep(2000);
      continue;
    }
    break;
  }
  if (lastResult && lastResult.status !== 0) {
    const stderr = lastResult.stderr ? lastResult.stderr.toString().trim().slice(0, 500) : "";
    const spawnErr = lastResult.error ? String(lastResult.error.message || lastResult.error.code || "").slice(0, 200) : "";
    const detail = stderr || spawnErr;
    throw new Error(`package install failed (exit ${lastResult.status})${detail ? `: ${detail}` : ""}`);
  }
}

async function restartServices(info) {
  updateStatus({ stage: "restarting" });
  if (binaryRestart && !info.systemd) {
    let spawnError;
    restartedBinary = cp.spawn(binaryRestart.binaryPath, binaryRestart.binaryArgs, {
      cwd: binaryRestart.cwd, detached: true, stdio: "ignore", windowsHide: true,
      env: { ...process.env, ...binaryEnvironment, OMP_WEB_PACKAGE_DIR: packageDir },
    });
    restartedBinary.once("error", (error) => { spawnError = error; });
    restartedBinary.unref();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (restartedBinary.exitCode !== null || restartedBinary.signalCode !== null) throw new Error("Binary exited during startup");
      if (await probeServer()) {
        await sleep(500);
        if (restartedBinary.exitCode !== null || restartedBinary.signalCode !== null) throw new Error("Binary exited during startup");
        return;
      }
      await sleep(200);
    }
    throw new Error("Binary did not become ready within 30 seconds");
  }
  if (info.systemd) {
    systemctl("start");
    if (binaryRestart) {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        systemctl("is-active");
        if (await probeServer()) {
          await sleep(500);
          systemctl("is-active");
          if (await probeServer()) return;
        }
        await sleep(200);
      }
      throw new Error("Binary did not become ready within 30 seconds");
    }
    // A Type=simple start returns once the process is forked; a release that
    // crashes on startup shows up as not active a moment later.
    await sleep(3000);
    systemctl("is-active");
    return;
  }
  if (info.launchd) {
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : 501;
      cp.spawnSync("launchctl", ["bootstrap", `gui/${uid}`, path.join(os.homedir(), "Library", "LaunchAgents", "com.kahme247.ompweb.plist")], { timeout: 15000, windowsHide: true });
    } catch {}
    await sleep(1000);
    return;
  }
  if (info.tray) {
    try {
      const trayBin = path.join(packageDir, "bin", "omp-web-tray.js");
      if (fs.existsSync(trayBin)) {
        cp.spawn(process.execPath, [trayBin, "--start"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      }
    } catch {}
    await sleep(1000);
    return;
  }
  // Plain next: ask launcher to restart via armed marker handshake
  try {
    const restartRequest = path.join(root, attemptId + ".restart-request.json");
    const restartAck = path.join(root, attemptId + ".restart-ack.json");
    atomicWrite(restartRequest, { attemptId, port: descriptor && descriptor.port, hostname: descriptor && descriptor.hostname, requestedAt: new Date().toISOString() });
    // Wait up to 30s for ack
    for (let i = 0; i < 30; i++) {
      if (fs.existsSync(restartAck)) break;
      await sleep(1000);
    }
  } catch {}
}

function probeServer() {
  return new Promise((resolve) => {
    const port = descriptor && descriptor.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return resolve(false);
    const hostname = descriptor.hostname === "0.0.0.0" ? "127.0.0.1" : descriptor.hostname === "::" ? "::1" : descriptor.hostname;
    const socket = net.createConnection({ port, host: hostname || "127.0.0.1" });
    const finish = (ready) => { socket.destroy(); resolve(ready); };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function owned(file, directory = false) {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) || (process.getuid && info.uid !== process.getuid()) || (process.platform !== "win32" && (info.mode & 0o022)) || fs.realpathSync(file) !== path.resolve(file)) throw new Error("Unsafe update release path");
}
function validateOwnedTree(file) {
  const info = fs.lstatSync(file);
  owned(file, info.isDirectory());
  if (info.isDirectory()) for (const name of fs.readdirSync(file)) validateOwnedTree(path.join(file, name));
}
function removeOwnedTree(file) {
  validateOwnedTree(file);
  fs.rmSync(file, { recursive: true });
}
function readReleaseDescriptor(source) {
  const expected = path.join(root, "attempts", attemptId, "deploy.json");
  if (kind !== "app" || typeof source !== "string" || path.resolve(source) !== expected) throw new Error("Invalid binary release descriptor");
  owned(root, true);
  owned(path.join(root, "attempts"), true);
  owned(path.dirname(expected), true);
  owned(expected);
  const deploy = readJson(expected);
  const directory = deploy && deploy.directory;
  if (deploy?.attemptId !== attemptId || !/^[a-f0-9]{40}$/.test(deploy.sha || "") || typeof directory !== "string" || path.dirname(directory) !== path.join(root, "attempts", attemptId, "staging")) throw new Error("Invalid deployment release identity");
  owned(path.dirname(directory), true);
  validateOwnedTree(directory);
  for (const file of [process.platform === "win32" ? "ompweb.exe" : "ompweb", "dist/index.html", "lib/omp/session-edit-extension.mjs"]) {
    try { owned(path.join(directory, file)); } catch { throw new Error("Incomplete or unsafe deployment release layout"); }
  }
  return deploy;
}

function runDeployHook() {
  if (!process.env.OMP_WEB_SELF_UPDATE_CMD) throw new Error("Deployment hook is not configured");
  const deploy = readReleaseDescriptor(deployDescriptor);
  const directory = deploy.directory;
  updateStatus({ stage: "installing" });
  const result = cp.spawnSync(process.env.OMP_WEB_SELF_UPDATE_CMD, {
    shell: true, timeout: 15 * 60 * 1000, windowsHide: true,
    env: { ...process.env, OMP_WEB_UPDATE_SHA: deploy.sha, OMP_WEB_UPDATE_DIR: directory },
    stdio: "ignore",
  });
  if (result.error || result.status !== 0) throw new Error(`Deployment hook failed (exit ${result.status})`);
}

async function stopRestartedBinary(info) {
  if (info.systemd) return systemctl("stop");
  if (!restartedBinary?.pid || restartedBinary.exitCode !== null || restartedBinary.signalCode !== null) return;
  restartedBinary.kill("SIGTERM");
  const deadline = Date.now() + 10000;
  while (restartedBinary.exitCode === null && restartedBinary.signalCode === null) {
    if (Date.now() > deadline) throw new Error("Candidate did not stop; refusing an unsafe rollback");
    await sleep(100);
  }
}

function processIdentity(pid) {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return /^\d+$/.test(start || "") ? `linux:${fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}` : null;
    }
    const result = process.platform === "win32"
      ? cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`], { encoding: "utf8", timeout: 10000, windowsHide: true })
      : cp.spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C" } });
    const value = result.stdout?.trim();
    return result.status === 0 && value ? `${process.platform}:${value}` : null;
  } catch { return null; }
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function stopOriginalBinary() {
  if (systemdUnit) {
    const result = cp.spawnSync("systemctl", [...systemctlScope, "show", "--property=MainPID", "--value", systemdUnit], { encoding: "utf8", timeout: 5000 });
    if (result.status !== 0 || Number(result.stdout?.trim()) !== binaryRestart.pid) throw new Error("Server service main process changed; refusing to stop it");
    systemctl("stop");
    return { systemd: true };
  }
  const pid = binaryRestart.pid;
  if (processAlive(pid)) {
    if (!binaryRestart.identity || processIdentity(pid) !== binaryRestart.identity) throw new Error("Server process identity changed; refusing to signal it");
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 10000;
    while (processAlive(pid) && processIdentity(pid) === binaryRestart.identity) {
      if (Date.now() > deadline) throw new Error("Original binary did not stop safely");
      await sleep(100);
    }
  }
  return { systemd: false };
}

async function installBinaryRelease() {
  const release = readReleaseDescriptor(binaryDescriptor);
  const restart = release.restart;
  owned(packageDir, true);
  if (!restart || typeof restart.binaryPath !== "string" || path.dirname(restart.binaryPath) !== path.resolve(packageDir) ||
      !Array.isArray(restart.binaryArgs) || restart.binaryArgs.some((value) => typeof value !== "string") ||
      typeof restart.cwd !== "string" || !path.isAbsolute(restart.cwd) ||
      !Number.isSafeInteger(restart.pid) || restart.pid <= 1 || restart.pid === process.pid ||
      !binaryEnvironment || typeof binaryEnvironment !== "object" || Array.isArray(binaryEnvironment) ||
      Object.values(binaryEnvironment).some((value) => typeof value !== "string")) throw new Error("Invalid binary restart descriptor");
  owned(restart.binaryPath);
  const binaryName = process.platform === "win32" ? "ompweb.exe" : "ompweb";
  const entries = fs.readdirSync(release.directory).map((source) => ({
    source, name: source === binaryName ? path.basename(restart.binaryPath) : source,
  }));
  if (new Set(entries.map(({ name }) => name)).size !== entries.length || entries.some(({ name }) => name.startsWith("."))) throw new Error("Unsafe binary release members");
  for (const { name } of entries) {
    const dest = path.join(packageDir, name);
    if (fs.existsSync(dest)) validateOwnedTree(dest);
    else {
      try { fs.lstatSync(dest); throw new Error("Unsafe existing release member"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  const work = path.join(packageDir, `.ompweb-update-${attemptId}`);
  fs.mkdirSync(work, { mode: 0o700 });
  const candidate = path.join(work, "candidate");
  const backup = path.join(work, "backup");
  fs.mkdirSync(candidate, { mode: 0o700 });
  fs.mkdirSync(backup, { mode: 0o700 });
  atomicWrite(path.join(work, "owner.json"), { attemptId, installDir: path.resolve(packageDir) });
  const saved = [];
  const installed = [];
  let services;
  let swapped = false;
  binaryRestart = restart;
  try {
    for (const { source, name } of entries) fs.cpSync(path.join(release.directory, source), path.join(candidate, name), { recursive: true, errorOnExist: true, force: false });
    validateOwnedTree(candidate);
    services = await stopOriginalProcesses();
    updateStatus({ stage: "installing" });
    swapped = true;
    for (const { name } of entries) {
      const dest = path.join(packageDir, name);
      if (fs.existsSync(dest)) {
        fs.renameSync(dest, path.join(backup, name));
        saved.push(name);
      }
      fs.renameSync(path.join(candidate, name), dest);
      installed.push(name);
    }
    await restartServices(services);
  } catch (error) {
    if (swapped) {
      try {
        await stopRestartedBinary(services);
        for (const name of installed.reverse()) fs.renameSync(path.join(packageDir, name), path.join(candidate, name));
        for (const name of saved.reverse()) fs.renameSync(path.join(backup, name), path.join(packageDir, name));
        await restartServices(services);
      } catch (rollbackError) {
        throw new Error(`Binary update failed: ${error.message}; rollback failed: ${rollbackError.message}; backup retained at ${backup}`);
      }
    } else if (services) {
      await restartServices(services);
    }
    removeOwnedTree(work);
    throw error;
  }
  removeOwnedTree(work);
}

async function main() {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId || "") || !root || !packageDir || !target) {
    process.exit(1);
  }
  // Check abort
  if (fs.existsSync(abortFile())) {
    updateStatus({ state: "failed", error: (readJson(abortFile()) || {}).reason || "aborted", finishedAt: new Date().toISOString(), cleanupReady: true });
    process.exit(0);
  }
  // Check go marker exists (commit signal)
  if (!fs.existsSync(markerFile("go"))) {
    // wait briefly for go
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(markerFile("go"))) break;
      await sleep(200);
    }
  }
  updateStatus({ state: "running", stage: "preparing", startedAt: new Date().toISOString() });
  await sleep(1000); // PREPARING_MIN 1s

  let svcInfo = { launchd: false, tray: false };
  try {
    if (binaryDescriptor) {
      await installBinaryRelease();
      updateStatus({ state: "succeeded", stage: "finalizing", finishedAt: new Date().toISOString(), cleanupReady: true });
      atomicWrite(markerFile("complete.json"), { attemptId, completedAt: new Date().toISOString() });
      return;
    }
    if (deployDescriptor) {
      runDeployHook();
      updateStatus({ state: "succeeded", stage: "finalizing", finishedAt: new Date().toISOString(), cleanupReady: true });
      atomicWrite(markerFile("complete.json"), { attemptId, completedAt: new Date().toISOString() });
      return;
    }
    if (kind !== "omp") svcInfo = await stopOriginalProcesses();
    await runManagerGate();
    try {
      const pkgPath = path.join(packageDir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = readJson(pkgPath);
        if (pkg && pkg.version !== target) {
          // version mismatch not fatal but record
        }
      }
    } catch {}
    if (kind !== "omp") await restartServices(svcInfo);
    await sleep(500);
    updateStatus({ state: "succeeded", stage: "finalizing", finishedAt: new Date().toISOString(), cleanupReady: true });
    // write complete marker
    try { atomicWrite(markerFile("complete.json"), { attemptId, completedAt: new Date().toISOString() }); } catch {}
  } catch (e) {
    let msg = e instanceof Error ? e.message : String(e);
    // Never leave the service stopped after a failed install.
    if (systemdUnit && !deployDescriptor && !binaryDescriptor) {
      try { systemctl("start"); } catch { msg = `${systemdUnit} is still stopped: ${msg}`; }
    }
    updateStatus({ state: "failed", error: msg.slice(0, 240), finishedAt: new Date().toISOString(), cleanupReady: true });
  }
}

module.exports = { runSelfUpdateWorker: main };
if (require.main === module) {
  main().catch((e) => {
    try { updateStatus({ state: "failed", error: String(e).slice(0, 240), finishedAt: new Date().toISOString(), cleanupReady: true }); } catch {}
    process.exitCode = 1;
  });
}
