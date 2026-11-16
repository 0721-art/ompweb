import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Database } from "bun:sqlite";

const store = await import("./tool-approval-store.ts");
const { loadWebServerSettings, saveWebServerSettings } = await import("./web-settings.ts");
const ask = { enabled: true, confirmation: "ask" };
const allow = { enabled: true, confirmation: "allow" };
const deny = { enabled: false, confirmation: "ask" };

function isolated(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-tool-approvals-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  store.closeToolApprovalStore();
  delete globalThis.__ompWebSettingsCache;
  t.after(() => {
    store.closeToolApprovalStore();
    delete globalThis.__ompWebSettingsCache;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, reopen: store.closeToolApprovalStore };
}

const grant = (sessionId, resourceKey, capability = "github.read_watch") =>
  store.grant(sessionId, "github.repository", resourceKey, capability);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("grants persist across restart and isolate capabilities", (t) => {
  const { reopen } = isolated(t);
  grant("session-a", "acme/widgets");
  grant("session-a", "acme/widgets", "github.discussions");
  assert.equal(store.has("session-a", "github.repository", "acme/widgets", "github.read_watch"), true);
  assert.equal(store.has("session-a", "github.repository", "acme/widgets", "github.actions.dispatch"), false);
  reopen();
  assert.deepEqual(plain(store.list()), [
    { sessionId: "session-a", resourceType: "github.repository", resourceKey: "acme/widgets", capability: "github.discussions" },
    { sessionId: "session-a", resourceType: "github.repository", resourceKey: "acme/widgets", capability: "github.read_watch" },
  ]);
});

test("rename merges identities, deletion is scoped, and revocation is idempotent", (t) => {
  isolated(t);
  grant("old", "acme/widgets");
  grant("new", "acme/widgets");
  grant("other", "acme/elsewhere", "github.discussions");
  store.renameSession("old", "new");
  assert.deepEqual(plain(store.list()).filter((entry) => entry.sessionId === "new"), [
    { sessionId: "new", resourceType: "github.repository", resourceKey: "acme/widgets", capability: "github.read_watch" },
  ]);
  assert.equal(store.revoke("new", "github.repository", "acme/widgets", "github.read_watch"), true);
  assert.equal(store.revoke("new", "github.repository", "acme/widgets", "github.read_watch"), false);
  store.removeSession("other");
  assert.deepEqual(store.list(), []);
});

test("capability and clear-all revocation do not cross capability boundaries", (t) => {
  isolated(t);
  grant("one", "acme/widgets");
  grant("two", "acme/elsewhere", "github.discussions");
  assert.equal(store.revokeCapability("github.read_watch"), 1);
  assert.equal(store.has("two", "github.repository", "acme/elsewhere", "github.discussions"), true);
  assert.equal(store.clear(), 1);
  assert.deepEqual(store.list(), []);
});

test("all key fields are bounded and prototype-safe", (t) => {
  isolated(t);
  for (const args of [
    ["", "github.repository", "acme/widgets", "github.read_watch"],
    ["s", "__proto__", "acme/widgets", "github.read_watch"],
    ["s", "github.repository", "", "github.read_watch"],
    ["s", "github.repository", "x".repeat(2049), "github.read_watch"],
    ["s", "github.repository", "acme/widgets", "constructor"],
  ]) assert.throws(() => store.grant(...args), /invalid/i);
  assert.deepEqual(store.list(), []);
});

test("legacy GitHub read grants migrate once without dropping the evidence table", (t) => {
  const { dir, reopen } = isolated(t);
  const oldDir = join(dir, "omp-web");
  mkdirSync(oldDir, { recursive: true });
  const legacyPath = join(oldDir, "github-watches.sqlite");
  const legacy = new Database(legacyPath);
  legacy.exec("CREATE TABLE read_grants (session_id TEXT NOT NULL, repo_key TEXT NOT NULL, PRIMARY KEY (session_id, repo_key))");
  legacy.prepare("INSERT INTO read_grants VALUES (?, ?)").run("legacy-session", "acme/widgets");
  legacy.close(true);

  assert.equal(store.has("legacy-session", "github.repository", "acme/widgets", "github.read_watch"), true);
  assert.equal(store.revoke("legacy-session", "github.repository", "acme/widgets", "github.read_watch"), true);
  reopen();
  assert.equal(store.has("legacy-session", "github.repository", "acme/widgets", "github.read_watch"), false, "a revoked migrated grant must not be imported again");
  const evidence = new Database(legacyPath, { readonly: true });
  try {
    assert.deepEqual(evidence.prepare("SELECT session_id, repo_key FROM read_grants").all(), [{ session_id: "legacy-session", repo_key: "acme/widgets" }]);
  } finally {
    evidence.close(true);
  }
});

test("policy revocation happens before persistence and a revoke failure fails closed", (t) => {
  const { dir } = isolated(t);
  saveWebServerSettings({ toolPolicies: { global: { "github.read_watch": allow } } });
  grant("s", "acme/widgets");
  saveWebServerSettings({ toolPolicies: { global: { "github.read_watch": ask } } });
  assert.equal(store.has("s", "github.repository", "acme/widgets", "github.read_watch"), false);

  grant("s", "acme/widgets", "github.discussions");
  saveWebServerSettings({ toolPolicies: { global: { "github.discussions": deny } } });
  assert.equal(store.has("s", "github.repository", "acme/widgets", "github.discussions"), false);

  saveWebServerSettings({ toolPolicies: { agents: { reviewer: { "github.actions.dispatch": allow } } } });
  grant("s", "acme/widgets", "github.actions.dispatch");
  saveWebServerSettings({ toolPolicies: { agents: { reviewer: { "github.actions.dispatch": ask } } } });
  assert.equal(store.has("s", "github.repository", "acme/widgets", "github.actions.dispatch"), false);

  saveWebServerSettings({ toolPolicies: { global: { "github.actions.rerun": allow } } });
  grant("s", "acme/widgets", "github.actions.rerun");
  saveWebServerSettings({ toolPolicies: { agents: { reviewer: { "github.actions.rerun": ask } } } });
  assert.equal(store.has("s", "github.repository", "acme/widgets", "github.actions.rerun"), false, "a narrowed inherited allow must revoke too");

  saveWebServerSettings({ toolPolicies: { modelRoles: { task: { "github.actions.cancel": allow } } } });
  grant("s", "acme/widgets", "github.actions.cancel");
  saveWebServerSettings({ toolPolicies: { agents: { reviewer: { "github.actions.cancel": ask } } } });
  assert.equal(store.has("s", "github.repository", "acme/widgets", "github.actions.cancel"), false, "an agent ask must revoke grants that may have inherited role allow");

  saveWebServerSettings({ toolPolicies: { global: { "github.read_watch": allow } } });
  grant("s", "acme/widgets");
  store.closeToolApprovalStore();
  const approvalPath = join(dir, "omp-web", "tool-approvals.sqlite");
  renameSync(approvalPath, `${approvalPath}.saved`);
  mkdirSync(approvalPath);
  assert.throws(() => saveWebServerSettings({ toolPolicies: { global: { "github.read_watch": ask } } }));
  assert.deepEqual(loadWebServerSettings().toolPolicies.global["github.read_watch"], allow);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "omp-web-settings.json"), "utf8")).toolPolicies.global["github.read_watch"], allow);
});
