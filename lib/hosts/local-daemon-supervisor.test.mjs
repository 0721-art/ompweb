import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { mockBuiltin } from "../../tests/mock-builtin.mjs";

const fixtureModes = new Map();
if (process.platform === "win32") {
  // These cases simulate POSIX supervisors; Windows stat mode bits cannot represent their permission contract.
  const nativeStat = fs.stat.bind(fs);
  await mockBuiltin(test, "node:fs", { promises: { ...fs, async stat(...args) {
    const info = await nativeStat(...args);
    const mode = fixtureModes.get(String(args[0]));
    if (mode !== undefined) info.mode = (info.mode & ~0o777) | mode;
    return info;
  } } });
}
const { inspectInstalledHostSupervisor } = await import("./local-daemon-supervisor.ts");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "omp-web-supervisor-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home: join(root, "home") };
}

function put(file, contents, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents, { mode });
  chmodSync(file, mode);
  fixtureModes.set(file, mode);
}

const windowsInventory = (overrides = {}) => JSON.stringify({
  user: "DOMAIN\\test",
  tasks: [],
  services: [],
  ...overrides,
});

test("proved native-supervisor absence allows standalone startup on every platform", async (t) => {
  const { root, home } = fixture(t);
  assert.equal(await inspectInstalledHostSupervisor({
    platform: "linux",
    home,
    managerAvailable: async () => false,
    run: async () => { throw new Error("systemctl must not run without a native manager"); },
  }), null);
  assert.equal(await inspectInstalledHostSupervisor({ platform: "darwin", home, root, uid: 501, run: async () => { throw new Error("launchctl must not run"); } }), null);
  assert.equal(await inspectInstalledHostSupervisor({
    platform: "win32",
    home: "C:\\Users\\test",
    env: { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\test", OMP_WEB_PACKAGE_DIR: "C:\\app" },
    run: async () => windowsInventory(),
  }), null);
});

test("Linux controls only the verified installer user unit", async (t) => {
  const { home } = fixture(t);
  const unit = join(home, ".config", "systemd", "user", "ompweb-host.service");
  const install = join(home, "install");
  const executable = join(install, "bin", "ompweb");
  put(executable, "#!/bin/sh\nexit 0\n");
  put(unit, `[Service]\nExecStart=${executable} host\n`);
  const calls = [];
  const supervisor = await inspectInstalledHostSupervisor({
    platform: "linux",
    home,
    env: { HOME: home, OMP_WEB_PACKAGE_DIR: install },
    managerAvailable: async () => true,
    run: async (command, args) => {
      calls.push([command, args]);
      if (args.includes("list-unit-files")) return args.includes("--user") ? "ompweb-host.service enabled" : "";
      if (args.includes("show")) return `Id=ompweb-host.service\nLoadState=loaded\nFragmentPath=${unit}\nExecStart={ path=${executable} ; argv[]=${executable} host ; }\nEnvironment=`;
      return "";
    },
  });
  assert.equal(supervisor.description, "systemd user unit ompweb-host.service");
  await supervisor.start();
  assert.deepEqual(calls.at(-1), ["systemctl", ["--user", "start", "ompweb-host.service"]]);
});

test("a custom system unit targeting this agent blocks foreground without privileged control", async (t) => {
  const { home } = fixture(t);
  const unit = join(home, "system", "custom-supervisor.service");
  const agent = join(home, "agent");
  const wrapper = join(home, "bin", "supervisor");
  put(wrapper, "#!/bin/sh\nexec /opt/ompweb host\n");
  put(unit, `[Service]\nEnvironment=PI_CODING_AGENT_DIR=${agent}\nExecStart=${wrapper}\n`);
  const calls = [];
  const supervisor = await inspectInstalledHostSupervisor({
    platform: "linux",
    home,
    env: { HOME: home, PI_CODING_AGENT_DIR: agent, OMP_WEB_PACKAGE_DIR: "/opt/ompweb" },
    managerAvailable: async () => true,
    run: async (command, args) => {
      calls.push([command, args]);
      if (args.includes("list-unit-files")) return args.includes("--user") ? "" : "custom-supervisor.service enabled";
      if (args.includes("list-units")) return "";
      return `Id=custom-supervisor.service\nLoadState=loaded\nFragmentPath=${unit}\nExecStart={ path=${wrapper} ; argv[]=${wrapper} ; }\nEnvironment=PI_CODING_AGENT_DIR=${agent}`;
    },
  });
  assert.equal(supervisor.description, "systemd unit custom-supervisor.service");
  const before = calls.length;
  await supervisor.start();
  assert.equal(calls.length, before);
});

test("macOS controls its verified user agent but only waits on a matching system LaunchDaemon", async (t) => {
  const { root, home } = fixture(t);
  const userPlist = join(home, "Library", "LaunchAgents", "com.kahme247.ompweb-host.plist");
  put(userPlist, "<plist><dict><key>Label</key><string>com.kahme247.ompweb-host</string><key>ProgramArguments</key><array><string>ompweb</string><string>host</string></array><key>WorkingDirectory</key><string>/missing/work</string><key>StandardOutPath</key><string>/missing/log</string></dict></plist>");
  const calls = [];
  const user = await inspectInstalledHostSupervisor({
    platform: "darwin", home, root, uid: 501, env: { HOME: home },
    run: async (command, args) => { calls.push([command, args]); return "registered"; },
  });
  await user.start();
  assert.deepEqual(calls.at(-1), ["launchctl", ["kickstart", "gui/501/com.kahme247.ompweb-host"]]);
  rmSync(userPlist);

  const agent = join(home, "agent");
  const wrapper = join(root, "opt", "custom-supervisor");
  put(wrapper, "#!/bin/sh\nexec /opt/ompweb host\n");
  const systemPlist = join(root, "Library", "LaunchDaemons", "dev.example.custom-supervisor.plist");
  put(systemPlist, `<plist><dict><key>Label</key><string>dev.example.custom-supervisor</string><key>ProgramArguments</key><array><string>${wrapper}</string></array><key>EnvironmentVariables</key><dict><key>PI_CODING_AGENT_DIR</key><string>${agent}</string></dict></dict></plist>`);
  const system = await inspectInstalledHostSupervisor({
    platform: "darwin", home, root, uid: 501,
    env: { HOME: home, PI_CODING_AGENT_DIR: agent, OMP_WEB_PACKAGE_DIR: "/opt/ompweb" },
    run: async (command, args) => { calls.push([command, args]); return "registered"; },
  });
  assert.equal(system.description, "launchd job system/dev.example.custom-supervisor");
  const before = calls.length;
  await system.start();
  assert.equal(calls.length, before);
});

test("Windows authorizes the exact current-user task and detects a matching native service", async () => {
  const env = { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\test", OMP_WEB_PACKAGE_DIR: "C:\\app" };
  const task = { path: "\\", name: "omp-web-host", state: "Ready", userId: "DOMAIN\\test", actions: [{ execute: "powershell.exe", arguments: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"C:\\app\\scripts\\windows\\omp-web-host.ps1\"" }] };
  const calls = [];
  const supervisor = await inspectInstalledHostSupervisor({
    platform: "win32", home: env.USERPROFILE, env,
    run: async (command, args) => { calls.push([command, args]); return args.at(-1).includes("Get-ScheduledTask") ? windowsInventory({ tasks: [task] }) : ""; },
  });
  await supervisor.start();
  assert.equal(calls.every(([command]) => command === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"), true);
  assert.match(calls.at(-1)[1].at(-1), /Start-ScheduledTask/);

  const service = await inspectInstalledHostSupervisor({
    platform: "win32", home: env.USERPROFILE, env,
    run: async () => windowsInventory({ services: [{ name: "CustomHost", pathName: "\"C:\\app\\ompweb.exe\" host", startName: "DOMAIN\\test", state: "Start Pending" }] }),
  });
  assert.equal(service.description, "Windows service CustomHost");
  const customTask = await inspectInstalledHostSupervisor({
    platform: "win32", home: env.USERPROFILE, env,
    run: async () => windowsInventory({ tasks: [{ path: "\\Custom\\", name: "SameInstallHost", state: "Running", userId: "DOMAIN\\test", actions: [{ execute: "powershell.exe", arguments: "-File \"C:\\app\\scripts\\windows\\custom-host.ps1\"" }] }] }),
  });
  assert.equal(customTask.description, "Windows scheduled task \\Custom\\SameInstallHost");
});

test("another user, installation, or task action is never controlled by name alone", async () => {
  const env = { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\test", OMP_WEB_PACKAGE_DIR: "C:\\app" };
  const base = { path: "\\", name: "omp-web-host", state: "Ready", userId: "DOMAIN\\test" };
  const unrelated = [
    { ...base, userId: "DOMAIN\\other", actions: [{ execute: "powershell.exe", arguments: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"C:\\app\\scripts\\windows\\omp-web-host.ps1\"" }] },
    { ...base, actions: [{ execute: "powershell.exe", arguments: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"C:\\other\\scripts\\windows\\omp-web-host.ps1\"" }] },
  ];
  for (const task of unrelated) {
    assert.equal(await inspectInstalledHostSupervisor({
      platform: "win32", home: env.USERPROFILE, env,
      run: async () => windowsInventory({ tasks: [task] }),
    }), null);
  }
  const unsafe = { ...base, actions: [{ execute: "powershell.exe", arguments: "-Command \"& 'C:\\app\\scripts\\windows\\omp-web-host.ps1'; Write-Output unsafe\"" }] };
  const pendingTask = await inspectInstalledHostSupervisor({
    platform: "win32", home: env.USERPROFILE, env,
    run: async () => windowsInventory({ tasks: [unsafe] }),
  });
  assert.equal(pendingTask.description, "Windows scheduled task \\omp-web-host");
});

test("native inventory command and registration failures fail closed", async (t) => {
  const { root, home } = fixture(t);
  await assert.rejects(
    inspectInstalledHostSupervisor({ platform: "linux", home, managerAvailable: async () => true, run: async () => { throw new Error("systemctl unavailable"); } }),
    /systemctl unavailable/,
  );
  const agent = join(home, "agent");
  mkdirSync(agent, { recursive: true });
  const wrapper = join(root, "bin", "custom-host");
  put(wrapper, "#!/bin/sh\nexec /opt/ompweb host\n");
  put(join(root, "Library", "LaunchDaemons", "custom.plist"), `<plist><dict><key>Label</key><string>custom</string><key>ProgramArguments</key><array><string>${wrapper}</string></array><key>EnvironmentVariables</key><dict><key>PI_CODING_AGENT_DIR</key><string>${agent}</string></dict></dict></plist>`);
  await assert.rejects(
    inspectInstalledHostSupervisor({ platform: "darwin", home, root, uid: 501, env: { PI_CODING_AGENT_DIR: agent }, run: async () => { throw new Error("launchctl failed"); } }),
    /launchctl failed/,
  );
  await assert.rejects(
    inspectInstalledHostSupervisor({ platform: "win32", home: "C:\\Users\\test", run: async () => "not-json" }),
    /Could not inspect Windows host supervisors/,
  );
});

test("systemd templates are not queried as instances, while loaded host instances remain managed", async (t) => {
  const { home } = fixture(t);
  const install = join(home, "install"), executable = join(install, "ompweb");
  const unit = join(home, "ompweb@.service");
  put(executable, "#!/bin/sh\nexit 0\n");
  put(unit, `[Service]\nExecStart=${executable} host\n`);
  const supervisor = await inspectInstalledHostSupervisor({
    platform: "linux", home, env: { HOME: home, OMP_WEB_PACKAGE_DIR: install }, managerAvailable: async (user) => !user,
    run: async (_command, args) => {
      if (args.includes("list-unit-files")) return "ompweb@.service enabled\ngetty@.service enabled";
      if (args.includes("list-units")) return "ompweb@local.service loaded activating start Host";
      assert.ok(args.includes("ompweb@local.service"));
      assert.ok(!args.includes("ompweb@.service") && !args.includes("getty@.service"));
      return `Id=ompweb@local.service\nLoadState=loaded\nFragmentPath=${unit}\nExecStart={ path=${executable} ; argv[]=${executable} host ; }\nEnvironment=`;
    },
  });
  assert.equal(supervisor.description, "systemd unit ompweb@local.service");
});

test("a group-writable POSIX supervisor definition is refused before native control", async (t) => {
  const { home } = fixture(t);
  const unit = join(home, ".config", "systemd", "user", "ompweb-host.service");
  const install = join(home, "install"), executable = join(install, "ompweb");
  put(executable, "#!/bin/sh\nexit 0\n");
  put(unit, `[Service]\nExecStart=${executable} host\n`, 0o622);
  let controlled = false;
  await assert.rejects(inspectInstalledHostSupervisor({
    platform: "linux", home, env: { HOME: home, OMP_WEB_PACKAGE_DIR: install }, managerAvailable: async (user) => user,
    run: async (_command, args) => {
      if (args.includes("list-unit-files")) return "ompweb-host.service enabled";
      if (args.includes("list-units")) return "";
      if (args.includes("show")) return `Id=ompweb-host.service\nLoadState=loaded\nFragmentPath=${unit}\nExecStart={ path=${executable} ; argv[]=${executable} host ; }\nEnvironment=`;
      controlled = true;
      return "";
    },
  }), /not trusted/);
  assert.equal(controlled, false);
});
