import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import { mockBuiltin } from "../tests/mock-builtin.mjs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { tarArchive } from "./hosts/update-fixture.test-helper.mjs";
import { hostReleaseName } from "./hosts/update-worker.ts";

const {
  getSelfUpdateStatus,
  markSelfUpdateStopping,
  parseSystemdServiceCgroup,
  resolveSelfUpdateTempRoot,
  validateCommitSelfUpdate,
  acknowledgeSelfUpdate,
  cleanupStaleSelfUpdate,
} = await import("./self-update.ts");

test("parseSystemdServiceCgroup finds system and user services, and nothing outside one", () => {
  assert.deepEqual(parseSystemdServiceCgroup("0::/system.slice/ompweb-api.service\n"), { unit: "ompweb-api.service", user: false });
  assert.deepEqual(
    parseSystemdServiceCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/ompweb.service\n"),
    { unit: "ompweb.service", user: true },
  );
  assert.deepEqual(
    parseSystemdServiceCgroup("12:pids:/system.slice/x.service\n1:name=systemd:/system.slice/ompweb.service\n"),
    { unit: "ompweb.service", user: false },
  );
  assert.deepEqual(
    parseSystemdServiceCgroup("1:name=systemd:/system.slice/ompweb.service\n0::/\n"),
    { unit: "ompweb.service", user: false },
  );
  assert.equal(parseSystemdServiceCgroup("0::/user.slice/user-1000.slice/session-3.scope\n"), null);
  assert.equal(parseSystemdServiceCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-1.scope\n"), null);
  assert.equal(parseSystemdServiceCgroup(""), null);
});

test("temporary update roots preserve synthetic Windows and POSIX helper paths", () => {
  assert.equal(resolveSelfUpdateTempRoot("app", "win32", "C:\\Temp", 42), "C:\\Temp\\ompweb-self-update");
  assert.equal(resolveSelfUpdateTempRoot("omp", "win32", "C:\\Temp", 42), "C:\\Temp\\omp-self-update");
  for (const platform of ["linux", "darwin"]) {
    assert.equal(resolveSelfUpdateTempRoot("app", platform, "/__ompweb_temp_fixture__/tmp", 42), "/__ompweb_temp_fixture__/tmp/ompweb-self-update-42");
    assert.equal(resolveSelfUpdateTempRoot("omp", platform, "/__ompweb_temp_fixture__/tmp", 42), "/__ompweb_temp_fixture__/tmp/omp-self-update-42");
  }
});

function withUpdateState(t, { workerPid, leaseExpiresAt, state = "running" }) {
  const temporary = mkdtempSync(join(tmpdir(), "self-update-test-"));
  // os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
  const names = ["TMPDIR", "TEMP", "TMP"];
  const previous = names.map((name) => process.env[name]);
  for (const name of names) process.env[name] = temporary;
  t.after(() => {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    rmSync(temporary, { recursive: true, force: true });
  });
  const root = resolveSelfUpdateTempRoot("app");
  mkdirSync(root, { mode: 0o700 });
  const attemptId = "2e4c6460-5a8f-4ef7-8d81-42cb688a8bdc";
  if (leaseExpiresAt !== null) {
    writeFileSync(join(root, "lease.json"), JSON.stringify({ attemptId, kind: "app", expiresAt: leaseExpiresAt }), { mode: 0o600 });
  }
  writeFileSync(join(root, `${attemptId}.ready`), "{}", { mode: 0o600 });
  writeFileSync(join(root, "status.json"), JSON.stringify({
    attemptId,
    state,
    ...(state === "running" ? { stage: "stopping" } : {}),
    fromVersion: "0.5.2",
    targetVersion: "0.6.0",
    preparedAt: new Date().toISOString(),
    workerPid,
  }), { mode: 0o600 });
  return { statusFile: join(root, "status.json"), leaseFile: join(root, "lease.json"), attemptId };
}

// A pid far above any pid_max, so it is never alive.
const DEAD_PID = 2 ** 30;

test("a running update whose worker died is reported, and stored, as failed", (t) => {
  const { statusFile } = withUpdateState(t, { workerPid: DEAD_PID, leaseExpiresAt: Date.now() + 60_000 });
  const status = getSelfUpdateStatus("app");
  assert.equal(status.state, "failed");
  assert.equal(status.cleanupReady, true);
  assert.match(status.error, /worker stopped/);
  assert.equal(JSON.parse(readFileSync(statusFile, "utf8")).state, "failed");
});

test("a running update past its lease is failed even when its pid is alive (reused)", (t) => {
  withUpdateState(t, { workerPid: process.pid, leaseExpiresAt: Date.now() - 1 });
  assert.equal(getSelfUpdateStatus("app").state, "failed");
});

test("a running update with a live worker inside its lease stays running", (t) => {
  const { statusFile } = withUpdateState(t, { workerPid: process.pid, leaseExpiresAt: Date.now() + 60_000 });
  assert.equal(getSelfUpdateStatus("app").state, "running");
  assert.equal(JSON.parse(readFileSync(statusFile, "utf8")).state, "running");
});

test("a running update before its worker pid is recorded stays running", (t) => {
  withUpdateState(t, { workerPid: undefined, leaseExpiresAt: Date.now() + 60_000 });
  assert.equal(getSelfUpdateStatus("app").state, "running");
});

test("a running update without a lease is failed", (t) => {
  withUpdateState(t, { workerPid: process.pid, leaseExpiresAt: null });
  assert.equal(getSelfUpdateStatus("app").state, "failed");
});

test("a prepared update whose lease expired cannot be committed", (t) => {
  const { attemptId } = withUpdateState(t, { state: "prepared", leaseExpiresAt: Date.now() - 1 });
  assert.throws(() => validateCommitSelfUpdate(attemptId, "app"), { code: "lease_expired" });
});

test("starting a commit renews the lease, so a late commit is not reported as lost", (t) => {
  const { attemptId, leaseFile } = withUpdateState(t, { state: "prepared", leaseExpiresAt: Date.now() + 1_000 });
  assert.equal(validateCommitSelfUpdate(attemptId, "app"), "ready");
  markSelfUpdateStopping(attemptId, "app");
  assert.ok(JSON.parse(readFileSync(leaseFile, "utf8")).expiresAt > Date.now() + 10 * 60_000);
  assert.equal(getSelfUpdateStatus("app").state, "running");
});

// commitSelfUpdate spawns its worker detached: record the spawn instead of running one.
let freshImport = 0;

async function commitAndCaptureSpawn(t, { nodeBin, systemd = false, binary = false }) {
  const { attemptId, statusFile } = withUpdateState(t, { state: "prepared", leaseExpiresAt: Date.now() + 60_000 });
  if (binary) writeFileSync(statusFile, JSON.stringify({ ...JSON.parse(readFileSync(statusFile, "utf8")), binaryWorker: true }));
  const previous = process.env.OMP_WEB_NODE_BIN;
  if (nodeBin === undefined) delete process.env.OMP_WEB_NODE_BIN;
  else process.env.OMP_WEB_NODE_BIN = nodeBin;
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_WEB_NODE_BIN;
    else process.env.OMP_WEB_NODE_BIN = previous;
  });
  const spawns = [];
  const spawn = (command, args) => {
    spawns.push({ command, args });
    return { once() {}, unref() {}, pid: 2 ** 30 };
  };
  // The execFile fake reports this process as the unit's MainPID, so the systemd branch applies to it.
  const execFile = Object.assign(() => { throw new Error("execFile without promisify"); }, {
    [promisify.custom]: async (command) => ({ stdout: command === "systemctl" ? `${process.pid}\n` : "" }),
  });
  await mockBuiltin(t, "node:child_process", { spawn, execFile });
  // Pin the cgroup: the test may itself run inside a systemd service.
  const cgroup = systemd ? "0::/system.slice/ompweb-api.service\n" : "0::/user.slice/user-1000.slice/session-3.scope\n";
  const { readFileSync: realReadFileSync } = await import("node:fs");
  await mockBuiltin(t, "node:fs", {
    readFileSync: (path, ...rest) => (path === "/proc/self/cgroup" ? cgroup : realReadFileSync(path, ...rest)),
  });
  const { commitSelfUpdate } = await import(`./self-update.ts?fresh=${freshImport++}`);
  await commitSelfUpdate(attemptId, "app");
  assert.equal(spawns.length, 1);
  return spawns[0];
}

test("the update worker runs on OMP_WEB_NODE_BIN, not on the server's own runtime", async (t) => {
  const { command } = await commitAndCaptureSpawn(t, { nodeBin: "/opt/node/bin/node" });
  assert.equal(command, "/opt/node/bin/node");
});

test("the update worker falls back to the server's runtime without OMP_WEB_NODE_BIN", async (t) => {
  const { command } = await commitAndCaptureSpawn(t, {});
  assert.equal(command, process.execPath);
});

test("the update worker inside systemd-run's scope runs on OMP_WEB_NODE_BIN", { skip: process.platform !== "linux" }, async (t) => {
  const { command, args } = await commitAndCaptureSpawn(t, { nodeBin: "/opt/node/bin/node", systemd: true });
  assert.equal(command, "systemd-run");
  assert.ok(args.includes("--scope"));
  assert.equal(args[args.indexOf("--no-ask-password") + 1], "/opt/node/bin/node");
  assert.ok(!args.includes(process.execPath));
});


for (const scenario of [
  { name: "deployment hook through a symlinked temporary-directory ancestor", channel: "prerelease", symlinkTemporary: true },
  { name: "a digest-mismatched release", channel: "prerelease", badDigest: true },
]) {
test(`preparing ${scenario.name} pins a verified release without exposing credentials`, { skip: process.platform === "win32" }, async (t) => {
  const previous = { ...process.env };
  withUpdateState(t, { state: "prepared", leaseExpiresAt: Date.now() - 1000 });
  let canonicalTemporary;
  if (scenario.symlinkTemporary) {
    const actual = join(tmpdir(), "actual");
    const alias = join(tmpdir(), "alias");
    canonicalTemporary = join(actual, "temporary");
    mkdirSync(canonicalTemporary, { recursive: true });
    symlinkSync(actual, alias, "dir");
    for (const name of ["TMPDIR", "TEMP", "TMP"]) process.env[name] = join(alias, "temporary");
    canonicalTemporary = realpathSync(canonicalTemporary);
  }
  const root = resolveSelfUpdateTempRoot("app");
  if (scenario.symlinkTemporary) {
    assert.equal(root, join(canonicalTemporary, `ompweb-self-update-${process.getuid()}`));
    assert.equal(resolveSelfUpdateTempRoot("omp"), join(canonicalTemporary, `omp-self-update-${process.getuid()}`));
    assert.equal(existsSync(root), false);
  }
  const packageDir = join(tmpdir(), "package");
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  copyFileSync(new URL("../bin/omp-web-update-worker.js", import.meta.url), join(packageDir, "bin", "omp-web-update-worker.js"));
  const sha = "a".repeat(40);
  const tag = scenario.channel === "stable" ? "v99.0.0" : `20261112T120000Z-${sha.slice(0, 10)}`;
  writeFileSync(join(packageDir, "ompweb-build.json"), JSON.stringify({ sha: "b".repeat(40), builtAt: "2026-11-11T12:00:00Z" }));
  const fetch = globalThis.fetch;
  process.env.OMP_WEB_PACKAGE_DIR = packageDir;
  process.env.OMP_WEB_SELF_UPDATE_CMD = "/configured/deployer";
  delete process.env.OMP_WEB_BUILD_SHA;
  delete process.env.OMP_WEB_BUILD_DATE;
  delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  const name = hostReleaseName();
  const archive = gzipSync(tarArchive({
    [`${name}/ompweb`]: { data: `#!/bin/sh\necho '99.0.0 (${sha})'\n`, mode: 0o755 },
    [`${name}/ompweb-build.json`]: JSON.stringify({ sha, builtAt: "2026-11-12T11:00:00Z" }),
    [`${name}/dist/index.html`]: "release assets",
    [`${name}/lib/omp/session-edit-extension.mjs`]: "",
  }));
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("registry.npmjs.org")) return Response.json({ version: "99.0.0" });
    if (url.includes("/releases?")) return Response.json([{ tag_name: tag, prerelease: true, draft: false, published_at: "2026-11-12T12:00:00Z" }]);
    if (url.includes("/commits/")) return Response.json({ sha });
    if (url.includes("/compare/")) return Response.json({ status: "ahead" });
    if (url.includes("/releases/tags/")) return Response.json({ tag_name: tag, assets: [{ name: `${name}.tar.gz`, digest: `sha256:${scenario.badDigest ? "0".repeat(64) : createHash("sha256").update(archive).digest("hex")}` }] });
    return new Response(archive);
  };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    globalThis.fetch = fetch;
  });
  const { prepareSelfUpdate } = await import("./self-update.ts");
  if (scenario.badDigest) {
    await assert.rejects(prepareSelfUpdate("app", { channel: scenario.channel }), /digest/i);
    const status = getSelfUpdateStatus();
    assert.equal(status.state, "failed");
    acknowledgeSelfUpdate(status.attemptId);
    assert.equal(existsSync(join(root, "attempts", status.attemptId)), false);
    return;
  }
  const prepared = await prepareSelfUpdate("app", { channel: scenario.channel, token: "private-token" });
  const deploy = JSON.parse(readFileSync(join(root, "attempts", prepared.attemptId, "deploy.json"), "utf8"));
  assert.equal(deploy.sha, sha);
  assert.equal(readFileSync(join(deploy.directory, "dist", "index.html"), "utf8"), "release assets");
  assert.equal(existsSync(join(root, "attempts", prepared.attemptId, "worker.js")), true);
  assert.equal(deploy.restart, undefined);
  assert.ok(!JSON.stringify(getSelfUpdateStatus()).includes("private-token"));
  assert.ok(!JSON.stringify(getSelfUpdateStatus()).includes("private-server-hash"));
  assert.equal(existsSync(join(packageDir, "dist")), false);
  if (scenario.symlinkTemporary) {
    assert.equal(realpathSync(root), root);
    assert.equal(realpathSync(deploy.directory), deploy.directory);
    const worker = join(root, "attempts", prepared.attemptId, "worker.js");
    assert.equal(realpathSync(worker), worker);
    const statusFile = join(root, "status.json");
    writeFileSync(statusFile, JSON.stringify({ ...getSelfUpdateStatus(), state: "failed" }));
    acknowledgeSelfUpdate(prepared.attemptId);
    assert.equal(existsSync(root), false);
    assert.equal(existsSync(canonicalTemporary), true);
  }
});
}

for (const state of ["succeeded", "failed"]) {
  test(`acknowledgement removes owned staged artifacts after ${state}`, (t) => {
    const { attemptId, statusFile } = withUpdateState(t, { state, workerPid: DEAD_PID, leaseExpiresAt: Date.now() + 60000 });
    const root = resolveSelfUpdateTempRoot();
    const attempt = join(root, "attempts", attemptId);
    mkdirSync(join(attempt, "staging", "release", "dist"), { recursive: true, mode: 0o700 });
    for (const name of ["worker.js", "worker", "worker.exe", "deploy.json", "staging/release/dist/index.html"]) {
      writeFileSync(join(attempt, name), "owned", { mode: 0o600 });
    }
    assert.deepEqual(acknowledgeSelfUpdate(attemptId), { acknowledged: true, attemptId });
    assert.equal(existsSync(attempt), false);
    assert.equal(existsSync(statusFile), false);
    assert.equal(existsSync(root), false);
  });
}

test("stale cleanup removes a failed partially staged release", (t) => {
  const { attemptId, statusFile } = withUpdateState(t, { state: "failed", workerPid: DEAD_PID, leaseExpiresAt: null });
  const root = resolveSelfUpdateTempRoot();
  const attempt = join(root, "attempts", attemptId);
  mkdirSync(join(attempt, "staging", "partial"), { recursive: true, mode: 0o700 });
  writeFileSync(join(attempt, "staging", "partial", "ompweb"), "partial");
  cleanupStaleSelfUpdate(Date.now() + 25 * 60 * 60 * 1000);
  assert.equal(existsSync(statusFile), false);
  assert.equal(existsSync(attempt), false);
});

test("cleanup refuses a staged symlink without deleting its target or sibling artifacts", { skip: process.platform === "win32" }, (t) => {
  const { attemptId } = withUpdateState(t, { state: "failed", workerPid: DEAD_PID, leaseExpiresAt: null });
  const root = resolveSelfUpdateTempRoot();
  const attempt = join(root, "attempts", attemptId);
  mkdirSync(join(attempt, "staging"), { recursive: true, mode: 0o700 });
  const outside = join(root, "outside");
  writeFileSync(outside, "keep");
  writeFileSync(join(attempt, "worker"), "keep");
  symlinkSync(outside, join(attempt, "staging", "link"));
  assert.throws(() => acknowledgeSelfUpdate(attemptId), { code: "unsafe_update_state" });
  assert.equal(readFileSync(outside, "utf8"), "keep");
  assert.equal(existsSync(join(attempt, "worker")), true);
});

test("cleanup refuses a symlinked update root without touching its target", { skip: process.platform === "win32" }, (t) => {
  withUpdateState(t, { state: "failed", workerPid: DEAD_PID, leaseExpiresAt: null });
  const root = resolveSelfUpdateTempRoot();
  const outside = join(tmpdir(), "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "keep");
  rmSync(root, { recursive: true });
  symlinkSync(outside, root, "dir");
  assert.equal(resolveSelfUpdateTempRoot(), root);
  assert.throws(() => cleanupStaleSelfUpdate(), { code: "unsafe_update_state" });
  assert.equal(readFileSync(join(outside, "keep"), "utf8"), "keep");
});
