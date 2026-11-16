import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const store = await import("../../../lib/tool-approval-store.ts");
const route = await import("./route.ts");
const { ROUTE_MODULES } = await import("../../../server/routes.ts");
const { currentToolPolicyGeneration } = await import("../../../lib/tool-policy-lock.ts");

function isolated(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-tool-approval-route-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  store.closeToolApprovalStore();
  t.after(() => {
    store.closeToolApprovalStore();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

const request = (body) => new Request("http://localhost/api/tool-approvals", {
  method: "DELETE",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("the authenticated static API table registers the approvals route", () => {
  assert.equal(ROUTE_MODULES["tool-approvals"], route);
});

test("GET lists only bounded grant identity fields and DELETE revokes one grant", async (t) => {
  isolated(t);
  store.grant("session-a", "github.repository", "acme/widgets", "github.read_watch");
  const listed = await (await route.GET()).json();
  assert.deepEqual(listed, { grants: [{ sessionId: "session-a", resourceType: "github.repository", resourceKey: "acme/widgets", capability: "github.read_watch" }] });
  assert.equal(JSON.stringify(listed).includes("cursor"), false);
  assert.equal(JSON.stringify(listed).includes("message"), false);

  const revoked = await route.DELETE(request(listed.grants[0]));
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { revoked: true });
  assert.deepEqual(store.list(), []);
});

test("DELETE validates exact request shapes and supports explicit clear-all", async (t) => {
  isolated(t);
  store.grant("session-a", "github.repository", "acme/widgets", "github.read_watch");
  for (const body of [null, {}, { all: false }, { all: true, sessionId: "s" }, { sessionId: "s" }, { sessionId: "s", resourceType: "__proto__", resourceKey: "x", capability: "github.read_watch" }]) {
    const response = await route.DELETE(request(body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).code, "invalid_request");
  }
  const cleared = await route.DELETE(request({ all: true }));
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { cleared: 1 });
});

test("revoke and clear invalidate approval instances without narrowing unrelated watch policy", async (t) => {
  isolated(t);
  const a = { sessionId: "session-a", resourceType: "github.repository", resourceKey: "acme/widgets", capability: "github.read_watch" };
  const b = { ...a, sessionId: "session-b", resourceKey: "acme/other" };
  store.grant(a.sessionId, a.resourceType, a.resourceKey, a.capability);
  store.grant(b.sessionId, b.resourceType, b.resourceKey, b.capability);
  const generation = currentToolPolicyGeneration("github.read_watch");

  assert.equal((await route.DELETE(request(a))).status, 200);
  assert.equal(store.has(a.sessionId, a.resourceType, a.resourceKey, a.capability), false);
  assert.equal(store.has(b.sessionId, b.resourceType, b.resourceKey, b.capability), true, "a second session/repository watch remains authorized");
  assert.equal(currentToolPolicyGeneration("github.read_watch"), generation, "grant revoke is not a capability-wide policy narrowing");

  assert.equal((await route.DELETE(request({ all: true }))).status, 200);
  assert.equal(store.has(b.sessionId, b.resourceType, b.resourceKey, b.capability), false);
  assert.equal(currentToolPolicyGeneration("github.read_watch"), generation, "clear-all does not invalidate unrelated durable watch policy generations");
});

test("DELETE rejects malformed JSON", async () => {
  const response = await route.DELETE(new Request("http://localhost/api/tool-approvals", { method: "DELETE", body: "{" }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid_json");
});
