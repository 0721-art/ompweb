import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "node:net";

const WORKER = fileURLToPath(new URL("./omp-web-update-worker.js", import.meta.url));
const ATTEMPT = "11111111-2222-3333-4444-555555555555";

function freePort() {
  const result = spawnSync(process.execPath, ["-e", "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim());
}

// Runs the worker for a systemd unit with stub `systemctl` and `npm` on PATH.
function runWorker(t, { npmExit = 0, startExit = 0, activeExit = 0, deploy = false, binary = false, incomplete = false, hookExit = 0, kind = "app", unsafe = false, plainPort, candidateExit = false, candidateReady = true, servicePid = 1073741824, failInstall = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "update-worker-test-"));
  t.after(() => {
    const launch = join(dir, "launch.json");
    if (existsSync(launch)) {
      try { process.kill(JSON.parse(readFileSync(launch, "utf8")).pid, "SIGTERM"); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const servicePort = binary ? (plainPort || freePort()) : plainPort;
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> "${log}"\n[ "$2" = start ] && exit ${startExit}\n[ "$2" = is-active ] && { echo failed; exit ${activeExit}; }\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(dir, "npm"), `#!/bin/sh\necho "npm $*" >> "${log}"\nexit ${npmExit}\n`, { mode: 0o755 });
  writeFileSync(join(dir, "status.json"), JSON.stringify({ attemptId: ATTEMPT, state: "running" }), { mode: 0o600 });
  writeFileSync(join(dir, `${ATTEMPT}.go`), "{}", { mode: 0o600 });
  const install = join(dir, "install");
  mkdirSync(join(install, "dist"), { recursive: true, mode: 0o700 });
  writeFileSync(join(install, "dist", "index.html"), "old assets");
  writeFileSync(join(install, "keep.txt"), "user file");
  const launch = join(dir, "launch.json");
  const server = `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst server = require("node:net").createServer((s) => s.end()).listen(Number(process.argv[3]), "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(launch)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(), password: process.env.OMP_WEB_PASSWORD_HASH })));\nprocess.on("SIGTERM", () => server.close(() => process.exit(0)));\n`;
  writeFileSync(join(install, "ompweb"), binary ? server.replace("\n", "\n// release=old\n") : "old", { mode: 0o755 });
  if (plainPort) {
    writeFileSync(join(install, "ompweb"), server, { mode: 0o755 });
  }
  if (deploy || binary) {
    const release = join(dir, "attempts", ATTEMPT, "staging", "ompweb-linux-x64");
    mkdirSync(join(release, "dist"), { recursive: true, mode: 0o700 });
    mkdirSync(join(release, "lib", "omp"), { recursive: true, mode: 0o700 });
    writeFileSync(join(release, "ompweb"), binary ? (candidateExit ? "#!/usr/bin/env node\nprocess.exit(19);\n" : candidateReady ? server.replace("\n", "\n// release=new\n") : "#!/usr/bin/env node\n// release=new\nsetInterval(() => {}, 1000);\n") : deploy ? "#!/bin/sh\nexit 0\n" : "new", { mode: 0o755 });
    writeFileSync(join(release, "dist", "index.html"), "new release");
    if (!incomplete) writeFileSync(join(release, "lib", "omp", "session-edit-extension.mjs"), "");
    writeFileSync(join(dir, "attempts", ATTEMPT, "deploy.json"), JSON.stringify({
      attemptId: ATTEMPT, sha: "1".repeat(40), directory: release,
      ...(binary ? { restart: {
        binaryPath: join(install, "ompweb"), binaryArgs: ["--port", String(servicePort), "--no-open"],
        cwd: dir, pid: 1073741824, identity: null,
      } } : {}),
    }), { mode: 0o600 });
    writeFileSync(join(dir, "hook"), `#!/bin/sh\n[ -f "$OMP_WEB_UPDATE_DIR/dist/index.html" ] || exit 9\necho "hook $OMP_WEB_UPDATE_SHA" >> "${log}"\nexit ${hookExit}\n`, { mode: 0o755 });
  }
  if (binary && !plainPort) {
    const serviceState = join(dir, "service.pid");
    writeFileSync(join(dir, "systemctl"), `#!/bin/sh
echo "systemctl $*" >> "${log}"
[ "$2" = show ] && { echo ${servicePid}; exit 0; }
if [ "$2" = stop ]; then
  [ ! -f "${serviceState}" ] || kill "$(cat "${serviceState}")" 2>/dev/null || true
  sleep 0.1
  rm -f "${serviceState}"
  exit 0
fi
if [ "$2" = start ]; then
  [ ${startExit} -eq 0 ] || exit ${startExit}
  "${join(install, "ompweb")}" --port ${servicePort} --no-open >/dev/null 2>&1 &
  echo $! > "${serviceState}"
  exit 0
fi
if [ "$2" = is-active ]; then
  [ -f "${serviceState}" ] && kill -0 "$(cat "${serviceState}")" 2>/dev/null || exit 3
  grep -q 'release=new' "${join(install, "ompweb")}" && exit ${activeExit}
  exit 0
fi
exit 0
`, { mode: 0o755 });
    if (unsafe) {
      rmSync(join(install, "ompweb"));
      writeFileSync(join(dir, "foreign"), "do not change");
      symlinkSync(join(dir, "foreign"), join(install, "ompweb"));
    }
  }
  const inject = join(dir, "fail-install.cjs");
  if (failInstall) writeFileSync(inject, `const fs = require("node:fs"); const rename = fs.renameSync; let failed = false; fs.renameSync = (from, to) => { if (!failed && from.includes("/candidate/") && to === ${JSON.stringify(join(install, "ompweb"))}) { failed = true; throw new Error("fixture disk failure"); } return rename(from, to); };`);
  const result = spawnSync("node", [
    ...(failInstall ? ["--require", inject] : []),
    WORKER,
    "--attempt", ATTEMPT,
    "--root", dir,
    "--package-dir", binary ? install : dir,
    "--manager", "npm",
    "--manager-path", "npm",
    "--target", "0.6.0",
    "--kind", kind,
    ...(binary || plainPort ? ["--descriptor", JSON.stringify({ hostname: "127.0.0.1", port: servicePort })] : []),
    ...(!plainPort ? ["--systemd-unit", "ompweb.service", "--systemd-user", "1"] : []),
    ...(deploy || binary ? [binary ? "--binary-descriptor" : "--deploy-descriptor", join(dir, "attempts", ATTEMPT, "deploy.json")] : []),
  ], { env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, OMP_WEB_BINARY_RESTART_ENV: JSON.stringify({ OMP_WEB_PASSWORD_HASH: "preserved-private-hash" }), OMP_WEB_SELF_UPDATE_CMD: deploy ? join(dir, "hook") : "" }, timeout: 45000 });
  assert.equal(result.status, 0, String(result.stderr));
  return {
    calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
    status: JSON.parse(readFileSync(join(dir, "status.json"), "utf8")),
    binary: readFileSync(join(install, "ompweb"), "utf8"),
    assets: readFileSync(join(install, "dist", "index.html"), "utf8"),
    preserved: readFileSync(join(install, "keep.txt"), "utf8"),
    launch: existsSync(launch) ? JSON.parse(readFileSync(launch, "utf8")) : null,
    workExists: existsSync(join(install, `.ompweb-update-${ATTEMPT}`)),
  };
}

test("a systemd update stops the unit, installs, starts it and checks it stayed up", { skip: process.platform === "win32" }, (t) => {
  const { calls, status } = runWorker(t);
  assert.deepEqual(calls, [
    "systemctl --user stop ompweb.service",
    "npm install -g @kahme247/ompweb@0.6.0",
    "systemctl --user start ompweb.service",
    "systemctl --user is-active ompweb.service",
  ]);
  assert.equal(status.state, "succeeded");
});

test("a failed install starts the unit again", { skip: process.platform === "win32" }, (t) => {
  const { calls, status } = runWorker(t, { npmExit: 1 });
  assert.equal(calls.at(-1), "systemctl --user start ompweb.service");
  assert.equal(status.state, "failed");
  assert.match(status.error, /package install failed/);
});

test("a unit that will not start again is reported as stopped", { skip: process.platform === "win32" }, (t) => {
  const { status } = runWorker(t, { startExit: 1 });
  assert.equal(status.state, "failed");
  assert.match(status.error, /^ompweb\.service is still stopped: /);
});

test("a new release that does not stay up fails the update", { skip: process.platform === "win32" }, (t) => {
  const { status } = runWorker(t, { activeExit: 3 });
  assert.equal(status.state, "failed");
  assert.match(status.error, /systemctl is-active ompweb\.service failed: failed/);
});

test("a staged binary deploy hook receives the full SHA and unpacked layout without stopping or swapping the web install", { skip: process.platform === "win32" }, (t) => {
  const { calls, status } = runWorker(t, { deploy: true });
  assert.deepEqual(calls, [`hook ${"1".repeat(40)}`]);
  assert.equal(status.state, "succeeded");
});

test("an incomplete staged release never invokes the deployment hook", { skip: process.platform === "win32" }, (t) => {
  const { calls, status } = runWorker(t, { deploy: true, incomplete: true });
  assert.deepEqual(calls, []);
  assert.equal(status.state, "failed");
  assert.match(status.error, /layout/i);
});

test("a failed deployment hook does not stop or restart the web server", { skip: process.platform === "win32" }, (t) => {
  const { calls, status } = runWorker(t, { deploy: true, hookExit: 4 });
  assert.deepEqual(calls, [`hook ${"1".repeat(40)}`]);
  assert.equal(status.state, "failed");
  assert.match(status.error, /deployment hook/i);
});

test("a hook-free binary update replaces the release and restarts the original systemd unit", { skip: process.platform === "win32" }, (t) => {
  const { calls, status, binary, assets, preserved, launch } = runWorker(t, { binary: true });
  assert.equal(status.state, "succeeded");
  assert.match(binary, /release=new/);
  assert.equal(assets, "new release");
  assert.equal(preserved, "user file");
  assert.deepEqual(calls.slice(0, 3), ["systemctl --user show --property=MainPID --value ompweb.service", "systemctl --user stop ompweb.service", "systemctl --user start ompweb.service"]);
  assert.ok(calls.slice(3).length >= 2 && calls.slice(3).every((call) => call === "systemctl --user is-active ompweb.service"));
  assert.match(launch.args.join(" "), /^--port \d+ --no-open$/);
});

test("failed binary startup restores the old release and restarts it", { skip: process.platform === "win32" }, (t) => {
  const { calls, status, binary, assets, launch } = runWorker(t, { binary: true, activeExit: 3 });
  assert.equal(status.state, "failed");
  assert.match(status.error, /is-active/);
  assert.match(binary, /release=old/);
  assert.equal(assets, "old assets");
  assert.equal(calls.filter((call) => call === "systemctl --user stop ompweb.service").length, 2);
  assert.equal(calls.filter((call) => call === "systemctl --user start ompweb.service").length, 2);
  assert.equal(calls.at(-1), "systemctl --user is-active ompweb.service");
  assert.match(launch.args.join(" "), /^--port \d+ --no-open$/);
});

test("an active binary service that never opens its listener rolls back to the ready old release", { skip: process.platform === "win32" }, (t) => {
  const { status, binary, assets, launch } = runWorker(t, { binary: true, candidateReady: false });
  assert.equal(status.state, "failed");
  assert.match(status.error, /did not become ready/);
  assert.match(binary, /release=old/);
  assert.equal(assets, "old assets");
  assert.match(launch.args.join(" "), /--port \d+ --no-open/);
});

test("an incomplete binary release leaves the original service and release untouched", { skip: process.platform === "win32" }, (t) => {
  const { calls, status, binary } = runWorker(t, { binary: true, incomplete: true });
  assert.equal(status.state, "failed");
  assert.match(binary, /release=old/);
  assert.deepEqual(calls, []);
});

test("binary install refuses a linked executable before stopping the service", { skip: process.platform === "win32" }, (t) => {
  const { calls, status, binary } = runWorker(t, { binary: true, unsafe: true });
  assert.equal(status.state, "failed");
  assert.equal(binary, "do not change");
  assert.deepEqual(calls, []);
});

test("an OMP-only worker never invokes the server deployment hook", { skip: process.platform === "win32" }, (t) => {
  const { calls, status } = runWorker(t, { deploy: true, kind: "omp" });
  assert.equal(status.state, "failed");
  assert.deepEqual(calls, []);
});

test("a changed service main process is never stopped or replaced", { skip: process.platform === "win32" }, (t) => {
  const { status, calls, binary, workExists } = runWorker(t, { binary: true, servicePid: 999 });
  assert.equal(status.state, "failed");
  assert.match(binary, /release=old/);
  assert.equal(workExists, false);
  assert.deepEqual(calls, ["systemctl --user show --property=MainPID --value ompweb.service"]);
});

for (const candidateExit of [false, true]) {
  test(`a plain binary ${candidateExit ? "rollback" : "update"} restarts original arguments, cwd and authentication`, { skip: process.platform === "win32" }, async (t) => {
    const listener = createServer();
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const { status, launch, assets, preserved, calls, workExists } = runWorker(t, { binary: true, plainPort: port, candidateExit });
    assert.equal(status.state, candidateExit ? "failed" : "succeeded");
    assert.deepEqual(launch.args, ["--port", String(port), "--no-open"]);
    assert.equal(launch.password, "preserved-private-hash");
    assert.match(launch.cwd, /update-worker-test-/);
    assert.equal(assets, candidateExit ? "old assets" : "new release");
    assert.equal(preserved, "user file");
    assert.equal(workExists, false);
    assert.deepEqual(calls, []);
  });
}

test("a failed in-place install restores all replaced entries and restarts the old service", { skip: process.platform === "win32" }, (t) => {
  const { status, binary, assets, preserved, workExists } = runWorker(t, { binary: true, failInstall: true });
  assert.equal(status.state, "failed");
  assert.match(status.error, /fixture disk failure/);
  assert.match(binary, /release=old/);
  assert.equal(assets, "old assets");
  assert.equal(preserved, "user file");
  assert.equal(workExists, false);
});
