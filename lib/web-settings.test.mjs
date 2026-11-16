import assert from "node:assert/strict";
import { existsSync, chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { loadWebServerSettings, saveWebServerSettings } = await import("./web-settings.ts");

const ask = { enabled: true, confirmation: "ask" };
const allow = { enabled: true, confirmation: "allow" };
const deny = { enabled: false, confirmation: "ask" };
const plain = (value) => JSON.parse(JSON.stringify(value));
const defaultToolPolicies = {
  version: 1,
  global: {
    "ompweb.agent_tools": deny,
    "ompweb.session_start": allow,
    "browser.open_url": allow,
    "github.read_watch": ask,
    "github.discussions": ask,
    "github.actions.dispatch": ask,
    "github.actions.cancel": ask,
    "github.actions.rerun": ask,
  },
  modelRoles: {},
  agents: {},
};
const expectedSettings = (overrides = {}) => ({
  autoResumeSessions: false,
  toolPolicies: defaultToolPolicies,
  agentEnv: {},
  browserTransport: "ws",
  uploadRetentionDays: 30,
  ...overrides,
});

function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-web-settings-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete globalThis.__ompWebSettingsCache;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("defaults apply when no settings file exists yet", () => {
  withAgentDir(() => {
    assert.deepEqual(plain(loadWebServerSettings()), expectedSettings());
  });
});

test("agentEnv round-trips through the settings file", () => {
  withAgentDir((dir) => {
    saveWebServerSettings({ agentEnv: { OBSIDIAN_API_KEY: "secret" } });
    const written = JSON.parse(readFileSync(join(dir, "omp-web-settings.json"), "utf8"));
    assert.deepEqual(written.agentEnv, { OBSIDIAN_API_KEY: "secret" });

    // Re-read from disk (the cache is keyed by path, so a fresh dir proves the read path).
    const fresh = mkdtempSync(join(tmpdir(), "omp-web-web-settings-"));
    writeFileSync(join(fresh, "omp-web-settings.json"), JSON.stringify(written), "utf8");
    delete globalThis.__ompWebSettingsCache;
    process.env.PI_CODING_AGENT_DIR = fresh;
    try {
      assert.deepEqual(plain(loadWebServerSettings()), expectedSettings({ agentEnv: { OBSIDIAN_API_KEY: "secret" } }));
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

test("the settings file, which holds agentEnv, is readable by its user only, even where it was wider before", { skip: process.platform === "win32" }, () => {
  withAgentDir((dir) => {
    const file = join(dir, "omp-web-settings.json");
    writeFileSync(file, "{}\n");
    chmodSync(file, 0o644);
    saveWebServerSettings({ agentEnv: { OBSIDIAN_API_KEY: "secret" } });
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

test("a patch leaves the other keys untouched", () => {
  withAgentDir(() => {
    saveWebServerSettings({ autoResumeSessions: true, agentEnv: { A: "1" } });
    saveWebServerSettings({ agentEnv: { B: "2" } });
    assert.deepEqual(plain(loadWebServerSettings()), expectedSettings({ autoResumeSessions: true, agentEnv: { B: "2" } }));
  });
});

test("saving merges the peer's disk policies and preserves a corrupt existing file", () => {
  withAgentDir((dir) => {
    const file = join(dir, "omp-web-settings.json");
    saveWebServerSettings({ toolPolicies: { global: { "github.discussions": allow } }, uploadRetentionDays: 7 });
    const peer = structuredClone(loadWebServerSettings());
    peer.toolPolicies.global["github.discussions"] = ask;
    peer.uploadRetentionDays = 9;
    writeFileSync(file, JSON.stringify(peer), "utf8");

    const saved = saveWebServerSettings({ autoResumeSessions: true });
    assert.equal(saved.autoResumeSessions, true);
    assert.deepEqual(saved.toolPolicies.global["github.discussions"], ask);
    assert.equal(saved.uploadRetentionDays, 9);

    writeFileSync(file, "{ not json", "utf8");
    assert.throws(() => saveWebServerSettings({ autoResumeSessions: false }));
    assert.equal(readFileSync(file, "utf8"), "{ not json");
  });
});

test("settings GET reports peer permission changes and refuses unreadable values", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-permission-read-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete globalThis.__ompWebSettingsCache;
    rmSync(dir, { recursive: true, force: true });
  });
  saveWebServerSettings({ toolPolicies: { global: { "github.discussions": ask } } });
  const file = join(dir, "omp-web-settings.json");
  const peer = structuredClone(loadWebServerSettings());
  peer.toolPolicies.global["github.discussions"] = allow;
  writeFileSync(file, JSON.stringify(peer), "utf8");
  const { GET } = await import("../app/api/web-settings/route.ts");
  assert.deepEqual((await (await GET()).json()).toolPolicies.global["github.discussions"], allow, "the UI must not show a stale policy");
  writeFileSync(file, "{ not json", "utf8");
  const unreadable = await GET();
  assert.equal(unreadable.status, 503);
  assert.equal((await unreadable.json()).code, "settings_unavailable");
});

test("corrupt files fall back to fail-closed policies instead of throwing", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "omp-web-settings.json"), "{ not json", "utf8");
    const settings = loadWebServerSettings();
    assert.equal(Object.values(settings.toolPolicies.global).every((policy) => policy.enabled === false), true);
  });
});

test("agent tool policy round-trips, and malformed legacy values migrate disabled (#275)", () => {
  withAgentDir(() => {
    saveWebServerSettings({ toolPolicies: { global: { "ompweb.agent_tools": allow } } });
    assert.equal(loadWebServerSettings().toolPolicies.global["ompweb.agent_tools"].enabled, true);
  });
  withAgentDir((dir) => {
    writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ agentToolsEnabled: "yes" }), "utf8");
    assert.deepEqual(loadWebServerSettings().toolPolicies.global["ompweb.agent_tools"], deny);
  });
});


test("web settings PUT rejects legacy permission fields and returns normalized policies", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-actions-route-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete globalThis.__ompWebSettingsCache;
    rmSync(dir, { recursive: true, force: true });
  });
  const { GET, PUT } = await import("../app/api/web-settings/route.ts");
  for (const body of [
    { agentToolsEnabled: true },
    { githubWritesUnasked: true },
    { githubActionsPermissions: { dispatch: "allow" } },
  ]) {
    const response = await PUT(new Request("http://localhost/api/web-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).code, "invalid_settings");
  }

  const saved = await PUT(new Request("http://localhost/api/web-settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toolPolicies: { global: { "github.actions.cancel": allow } } }),
  }));
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).toolPolicies.global["github.actions.cancel"], allow);
  assert.deepEqual((await (await GET()).json()).toolPolicies.global["github.actions.cancel"], allow);
});

test("a missing browserTransport reads as ws, sse and ws round-trip, and unknown values (the experiment's ws-* included) read as ws with the pool numbers dropped", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ autoResumeSessions: true }), "utf8");
    assert.equal(loadWebServerSettings().browserTransport, "ws");
  });
  for (const transport of ["sse", "ws"]) {
    withAgentDir(() => {
      saveWebServerSettings({ browserTransport: transport });
      assert.equal(loadWebServerSettings().browserTransport, transport);
    });
  }
  for (const value of ["ws-client", "ws-client-split", "ws-session", "ws-pool", "websocket", true]) {
    withAgentDir((dir) => {
      writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ browserTransport: value, browserTransportPerSocket: 8, browserTransportMaxSockets: 3 }), "utf8");
      assert.deepEqual(plain(loadWebServerSettings()), expectedSettings(), `${JSON.stringify(value)} reads as ws`);
    });
  }
});

test("only string-valued agentEnv entries are kept", () => {
  withAgentDir((dir) => {
    writeFileSync(
      join(dir, "omp-web-settings.json"),
      JSON.stringify({ autoResumeSessions: "yes", agentEnv: { GOOD: "1", BAD: 2, WORSE: null, NESTED: { a: 1 } } }),
      "utf8",
    );
    assert.deepEqual(plain(loadWebServerSettings()), expectedSettings({ agentEnv: { GOOD: "1" } }));
  });
});

test("uploadRetentionDays defaults to 30, null and 1..3650 round-trip, and anything else stored reads as 30", () => {
  withAgentDir((dir) => {
    for (const days of [null, 1, 7, 90, 3650]) {
      saveWebServerSettings({ uploadRetentionDays: days });
      delete globalThis.__ompWebSettingsCache;
      assert.equal(loadWebServerSettings().uploadRetentionDays, days, `${days} round-trips through the file`);
    }
    for (const stored of [0, -5, 3651, 1.5, "7", true, {}, [7], undefined]) {
      writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ uploadRetentionDays: stored }), "utf8");
      delete globalThis.__ompWebSettingsCache;
      assert.equal(loadWebServerSettings().uploadRetentionDays, 30, `${JSON.stringify(stored)} reads as 30`);
    }
  });
});

test("a non-object agentEnv is dropped", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ agentEnv: "A=1" }), "utf8");
    assert.deepEqual(loadWebServerSettings().agentEnv, {});
  });
});

test("separate settings writers serialize partial tool policy updates", { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-settings-writers-"));
  const settingsFile = join(dir, "omp-web-settings.json");
  const lockFile = join(dir, "omp-web-settings.lock.sqlite");
  const readyFile = join(dir, "writer-a-ready");
  const proceedFile = join(dir, "writer-a-proceed");
  const probeFile = join(dir, "writer-b-probe");
  const settingsModule = new URL("./web-settings.ts", import.meta.url).href;
  const children = [];

  writeFileSync(settingsFile, JSON.stringify(expectedSettings()), { encoding: "utf8", mode: 0o600 });

  t.after(async () => {
    writeFileSync(proceedFile, "");
    for (const child of children) if (child.process.exitCode === null) child.process.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited.catch(() => {})));
    rmSync(dir, { recursive: true, force: true });
  });

  const launch = (script, env) => {
    const child = spawn(process.execPath, ["--eval", script], {
      env: { ...process.env, PI_CODING_AGENT_DIR: dir, SETTINGS_MODULE: settingsModule, SETTINGS_FILE: settingsFile, LOCK_FILE: lockFile, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const record = { process: child, exited, get stderr() { return stderr; } };
    children.push(record);
    return record;
  };
  const waitForFile = async (path, child) => {
    const deadline = Date.now() + 15_000;
    while (!existsSync(path)) {
      if (child.process.exitCode !== null || child.process.signalCode !== null) {
        throw new Error(`writer exited before ${path}: ${child.stderr}`);
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}: ${child.stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  const writerA = launch(`
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    const real = { ...fs };
    mock.module("fs", () => ({ ...real, writeFileSync(file, data, options) {
      if (String(file).startsWith(process.env.SETTINGS_FILE + ".tmp-" + process.pid + "-")) {
        real.writeFileSync(process.env.READY_FILE, "");
        const deadline = Date.now() + 15_000;
        while (!real.existsSync(process.env.PROCEED_FILE)) {
          if (Date.now() > deadline) throw new Error("settings writer barrier timed out");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
      return real.writeFileSync(file, data, options);
    }}));
    const { saveWebServerSettings } = await import(process.env.SETTINGS_MODULE);
    saveWebServerSettings({ toolPolicies: { global: { "github.actions.dispatch": { enabled: true, confirmation: "allow" } } } });
  `, { READY_FILE: readyFile, PROCEED_FILE: proceedFile });
  try {
    await waitForFile(readyFile, writerA);
    assert.ok(existsSync(lockFile), "writer A holds the private lock database after reading settings");
    if (process.platform !== "win32") assert.equal(statSync(lockFile).mode & 0o777, 0o600);

    const writerB = launch(`
      import { Database } from "bun:sqlite";
      import { writeFileSync } from "node:fs";
      const probe = new Database(process.env.LOCK_FILE);
      probe.exec("PRAGMA busy_timeout = 0");
      let blocked = false;
      try {
        probe.exec("BEGIN IMMEDIATE");
        probe.exec("ROLLBACK");
      } catch (error) {
        blocked = error?.code === "SQLITE_BUSY" || /busy|locked/i.test(String(error));
      } finally {
        probe.close(true);
      }
      writeFileSync(process.env.PROBE_FILE, blocked ? "blocked" : "free");
      const { saveWebServerSettings } = await import(process.env.SETTINGS_MODULE);
      saveWebServerSettings({ toolPolicies: { global: { "github.actions.cancel": { enabled: false, confirmation: "ask" } } } });
    `, { PROBE_FILE: probeFile });
    await waitForFile(probeFile, writerB);
    assert.equal(readFileSync(probeFile, "utf8"), "blocked", "writer B cannot enter while writer A is paused before its temp write");

    writeFileSync(proceedFile, "");
    const [a, b] = await Promise.all([writerA.exited, writerB.exited]);
    assert.deepEqual(a, { code: 0, signal: null }, writerA.stderr);
    assert.deepEqual(b, { code: 0, signal: null }, writerB.stderr);

    const saved = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.deepEqual(saved.toolPolicies.global["github.actions.dispatch"], allow);
    assert.deepEqual(saved.toolPolicies.global["github.actions.cancel"], deny);
    assert.deepEqual(saved.toolPolicies.global["github.actions.rerun"], ask);
  } finally {
    writeFileSync(proceedFile, "");
  }
});

test("legacy permissions migrate to effective versioned policies and cleanly persist once", () => {
  for (const [legacy, expected] of [
    [
      { agentToolsEnabled: false, githubWritesUnasked: false, githubActionsPermissions: { dispatch: "deny", cancel: "ask", rerun: "allow" } },
      { agentTools: deny, discussions: ask, dispatch: deny, cancel: ask, rerun: allow },
    ],
    [
      { agentToolsEnabled: true, githubWritesUnasked: true, githubActionsPermissions: { dispatch: "allow", cancel: "deny", rerun: "ask" } },
      { agentTools: allow, discussions: allow, dispatch: allow, cancel: deny, rerun: ask },
    ],
  ]) {
    withAgentDir((dir) => {
      const file = join(dir, "omp-web-settings.json");
      writeFileSync(file, JSON.stringify({ autoResumeSessions: true, ...legacy }), "utf8");
      const migrated = loadWebServerSettings().toolPolicies;
      assert.equal(migrated.version, 1);
      assert.deepEqual(Object.keys(migrated.modelRoles), []);
      assert.deepEqual(Object.keys(migrated.agents), []);
      assert.deepEqual(migrated.global["ompweb.agent_tools"], expected.agentTools);
      assert.deepEqual(migrated.global["github.read_watch"], ask);
      assert.deepEqual(migrated.global["github.discussions"], expected.discussions);
      assert.deepEqual(migrated.global["github.actions.dispatch"], expected.dispatch);
      assert.deepEqual(migrated.global["github.actions.cancel"], expected.cancel);
      assert.deepEqual(migrated.global["github.actions.rerun"], expected.rerun);

      saveWebServerSettings({});
      const once = readFileSync(file, "utf8");
      const persisted = JSON.parse(once);
      assert.equal(persisted.agentToolsEnabled, undefined);
      assert.equal(persisted.githubWritesUnasked, undefined);
      assert.equal(persisted.githubActionsPermissions, undefined);
      assert.deepEqual(persisted.toolPolicies, plain(migrated));
      saveWebServerSettings({});
      assert.equal(readFileSync(file, "utf8"), once, "migration is idempotent");
    });
  }
});

test("invalid legacy Actions storage migrates every operation disabled", () => {
  for (const githubActionsPermissions of [
    "ask",
    [],
    { dispatch: "ask", unknown: "allow" },
    { dispatch: "invalid", cancel: "allow", rerun: "allow" },
  ]) {
    withAgentDir((dir) => {
      writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ githubActionsPermissions }), "utf8");
      const global = loadWebServerSettings().toolPolicies.global;
      for (const operation of ["dispatch", "cancel", "rerun"]) {
        assert.deepEqual(global[`github.actions.${operation}`], deny, JSON.stringify(githubActionsPermissions));
      }
    });
  }
});

test("policy patches merge by scope and inherit removes only the selected override", () => {
  withAgentDir(() => {
    saveWebServerSettings({ toolPolicies: {
      global: { "github.actions.dispatch": allow },
      modelRoles: { task: { "github.actions.cancel": deny } },
      agents: { reviewer: { "github.actions.rerun": allow } },
    } });
    const updated = saveWebServerSettings({ toolPolicies: {
      modelRoles: { task: { "github.actions.dispatch": allow, "github.actions.cancel": "inherit" } },
      agents: { reviewer: { "github.actions.rerun": "inherit" } },
    } }).toolPolicies;
    assert.deepEqual(updated.global["github.actions.dispatch"], allow);
    assert.deepEqual(plain(updated.modelRoles), { task: { "github.actions.dispatch": allow } });
    assert.deepEqual(plain(updated.agents), {});
  });
});

test("the persistence boundary rejects legacy patches without changing stored bytes", () => {
  for (const patch of [
    { agentToolsEnabled: true },
    { githubWritesUnasked: true },
    { githubActionsPermissions: { dispatch: "allow" } },
  ]) {
    withAgentDir((dir) => {
      saveWebServerSettings({ autoResumeSessions: true });
      const file = join(dir, "omp-web-settings.json");
      const source = readFileSync(file, "utf8");
      assert.throws(() => saveWebServerSettings(patch), /toolPolicies|legacy|moved/i);
      assert.equal(readFileSync(file, "utf8"), source);
    });
  }
});

test("scope IDs are bounded, prototype-safe, and survive a JSON round trip", () => {
  for (const id of ["", "__proto__", "prototype", "constructor", "a".repeat(129), "space id", "slash/id"]) {
    withAgentDir(() => {
      assert.throws(() => saveWebServerSettings({ toolPolicies: { agents: { [id]: { "github.read_watch": allow } } } }), /scope|ID/i, id);
    });
  }

  withAgentDir((dir) => {
    const id = "reviewer_1.role-x";
    saveWebServerSettings({ toolPolicies: { agents: { [id]: { "github.read_watch": allow } } } });
    delete globalThis.__ompWebSettingsCache;
    const roundTrip = loadWebServerSettings().toolPolicies;
    assert.equal(Object.getPrototypeOf(roundTrip.agents), null);
    assert.equal(Object.getPrototypeOf(roundTrip.agents[id]), null);
    assert.deepEqual(JSON.parse(JSON.stringify(roundTrip.agents)), { [id]: { "github.read_watch": allow } });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "omp-web-settings.json"), "utf8")).toolPolicies.agents, { [id]: { "github.read_watch": allow } });
  });
});

test("malformed policy storage fails closed and is never overwritten", () => {
  for (const toolPolicies of [
    { version: 2, global: {}, modelRoles: {}, agents: {} },
    { version: 1, global: { "unknown.capability": allow }, modelRoles: {}, agents: {} },
    { version: 1, global: { "github.read_watch": { enabled: true, confirmation: "sometimes" } }, modelRoles: {}, agents: {} },
    { version: 1, global: {}, modelRoles: [], agents: {} },
  ]) {
    withAgentDir((dir) => {
      const file = join(dir, "omp-web-settings.json");
      const source = JSON.stringify({ toolPolicies });
      writeFileSync(file, source, "utf8");
      const loaded = loadWebServerSettings().toolPolicies;
      assert.equal(Object.values(loaded.global).every((policy) => policy.enabled === false), true);
      assert.throws(() => saveWebServerSettings({ autoResumeSessions: true }));
      assert.equal(readFileSync(file, "utf8"), source);
    });
  }
});