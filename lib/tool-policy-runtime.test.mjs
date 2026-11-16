import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "omp-tool-policy-runtime-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;

const { authorizeToolCapability, isToolCapabilityAllowed } = await import("./tool-policy-runtime.ts");
const { closeToolApprovalStore, has, list } = await import("./tool-approval-store.ts");
const { saveWebServerSettings } = await import("./web-settings.ts");

test.after(() => {
  closeToolApprovalStore();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

const policy = (enabled, confirmation = "ask") => ({ enabled, confirmation });
const configure = (global, modelRoles = {}, agents = {}) => saveWebServerSettings({
  toolPolicies: { global, modelRoles, agents },
});

async function authorize(overrides = {}) {
  const asked = [];
  const result = await authorizeToolCapability({
    capability: "github.read_watch",
    sessionId: "session-a",
    resourceType: "github.repository",
    resourceKey: "acme/widgets",
    capabilityLabel: "read and watch GitHub",
    confirm: async (message) => { asked.push(message); return true; },
    ...overrides,
  });
  return { asked, result };
}

test("remembered grants are isolated by session, repository and capability", async () => {
  configure({ "github.read_watch": policy(true), "github.discussions": policy(true) });
  const first = await authorize();
  assert.equal(first.asked.length, 1);
  assert.match(first.asked[0], /read and watch GitHub/);
  assert.match(first.asked[0], /acme\/widgets/);
  assert.match(first.asked[0], /session-a/);
  assert.equal((await authorize()).asked.length, 0);
  assert.equal((await authorize({ sessionId: "session-b" })).asked.length, 1);
  assert.equal((await authorize({ resourceKey: "acme/other" })).asked.length, 1);
  assert.equal((await authorize({ capability: "github.discussions", capabilityLabel: "comment on GitHub" })).asked.length, 1);
});

test("agent policy wins over role policy, role wins over global, and absent caller uses global", async () => {
  configure(
    { "github.read_watch": policy(false) },
    { task: { "github.read_watch": policy(true, "allow") } },
    { bot: { "github.read_watch": policy(false) } },
  );
  await assert.rejects(() => authorize(), /disabled/);
  assert.equal((await authorize({ caller: { modelRole: "task" } })).asked.length, 0);
  await assert.rejects(() => authorize({ caller: { agentId: "bot", modelRole: "task" } }), /disabled/);
});

test("mandatory target denial cannot be bypassed by caller override", async () => {
  configure({ "ompweb.session_start": policy(false) }, {}, { bot: { "ompweb.session_start": policy(true, "allow") } });
  await assert.rejects(() => authorize({
    capability: "ompweb.session_start",
    capabilityLabel: "start a session",
    caller: { agentId: "bot" },
    target: policy(false),
    resourceType: "host",
    resourceKey: "build",
  }), /target.*denies/i);
});

test("URL grants are origin-scoped", async () => {
  configure({ "browser.open_url": policy(true) });
  const first = await authorize({ capability: "browser.open_url", capabilityLabel: "open URLs", resourceType: "url.origin", resourceKey: "https://example.com" });
  assert.equal(first.asked.length, 1);
  assert.equal((await authorize({ capability: "browser.open_url", capabilityLabel: "open URLs", resourceType: "url.origin", resourceKey: "https://example.com" })).asked.length, 0);
  assert.equal((await authorize({ capability: "browser.open_url", capabilityLabel: "open URLs", resourceType: "url.origin", resourceKey: "https://other.example" })).asked.length, 1);
});

test("extension grants use extension identity while Bash never persists", async () => {
  configure({ "omp.extension_requests": policy(true), "omp.bash": policy(true) });
  assert.equal((await authorize({ capability: "omp.extension_requests", capabilityLabel: "approve extension requests", resourceType: "extension", resourceKey: "acme.safe" })).asked.length, 1);
  assert.equal((await authorize({ capability: "omp.extension_requests", capabilityLabel: "approve extension requests", resourceType: "extension", resourceKey: "acme.safe" })).asked.length, 0);
  assert.equal((await authorize({ capability: "omp.extension_requests", capabilityLabel: "approve extension requests", resourceType: "extension", resourceKey: "other.safe" })).asked.length, 1);
  assert.equal((await authorize({ capability: "omp.bash", capabilityLabel: "run Bash", resourceType: "command", resourceKey: "echo hi" })).asked.length, 1);
  assert.equal((await authorize({ capability: "omp.bash", capabilityLabel: "run Bash", resourceType: "command", resourceKey: "echo hi" })).asked.length, 1);
  assert.equal(list().some((entry) => entry.capability === "omp.bash"), false);
});

test("policy revocation blocks and removes remembered authority", async () => {
  configure({ "github.read_watch": policy(true) });
  await authorize();
  assert.equal(has("session-a", "github.repository", "acme/widgets", "github.read_watch"), true);
  configure({ "github.read_watch": policy(false) });
  assert.equal(has("session-a", "github.repository", "acme/widgets", "github.read_watch"), false);
  await assert.rejects(() => authorize(), /disabled/);
});

test("malformed caller provenance is rejected instead of inferred", async () => {
  configure({ "github.read_watch": policy(true, "allow") });
  await assert.rejects(() => authorize({ caller: { agentId: "bad id", modelRole: "task" } }), /caller/i);
});

test("synchronous consumers read current policy without compatibility settings", () => {
  configure({ "ompweb.agent_tools": policy(true), "github.read_watch": policy(true) });
  assert.equal(isToolCapabilityAllowed("ompweb.agent_tools"), true);
  assert.equal(isToolCapabilityAllowed("github.read_watch"), true);
  configure({ "github.read_watch": policy(false) });
  assert.equal(isToolCapabilityAllowed("github.read_watch"), false);
});
