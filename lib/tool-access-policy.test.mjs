import assert from "node:assert/strict";
import test from "node:test";

const {
  CAPABILITY_IDS,
  EMPTY_TOOL_POLICIES,
  resolveToolPolicy,
} = await import("./tool-access-policy.ts");

const capability = "github.actions.dispatch";
const ask = { enabled: true, confirmation: "ask" };
const allow = { enabled: true, confirmation: "allow" };
const deny = { enabled: false, confirmation: "ask" };

const policies = (overrides = {}) => ({
  ...EMPTY_TOOL_POLICIES,
  modelRoles: {},
  agents: {},
  ...overrides,
});

for (const { name, input, expected } of [
  {
    name: "inherits from global without caller provenance",
    input: { policies: policies(), capability, global: ask },
    expected: { caller: ask, target: undefined, allowed: true },
  },
  {
    name: "uses a model-role override when agent provenance is absent",
    input: { policies: policies({ modelRoles: { task: { [capability]: allow } } }), capability, global: ask, caller: { modelRole: "task" } },
    expected: { caller: allow, target: undefined, allowed: true },
  },
  {
    name: "an absent agent override falls through to the model role",
    input: { policies: policies({ modelRoles: { task: { [capability]: allow } }, agents: { reviewer: {} } }), capability, global: ask, caller: { agentId: "reviewer", modelRole: "task" } },
    expected: { caller: allow, target: undefined, allowed: true },
  },
  {
    name: "an agent override wins over the model role",
    input: { policies: policies({ modelRoles: { task: { [capability]: allow } }, agents: { reviewer: { [capability]: deny } } }), capability, global: ask, caller: { agentId: "reviewer", modelRole: "task" } },
    expected: { caller: deny, target: undefined, allowed: false },
  },
  {
    name: "a scoped override can explicitly re-enable a globally disabled capability",
    input: { policies: policies({ agents: { reviewer: { [capability]: allow } } }), capability, global: deny, caller: { agentId: "reviewer" } },
    expected: { caller: allow, target: undefined, allowed: true },
  },
  {
    name: "target denial remains a mandatory separate gate",
    input: { policies: policies({ agents: { reviewer: { [capability]: allow } } }), capability, global: deny, caller: { agentId: "reviewer" }, target: deny },
    expected: { caller: allow, target: deny, allowed: false },
  },
]) {
  test(name, () => assert.deepEqual(resolveToolPolicy(input), expected));
}

test("defines the initial capability groups", () => {
  assert.deepEqual(CAPABILITY_IDS, [
    "omp.bash",
    "omp.extension_requests",
    "ompweb.agent_tools",
    "ompweb.session_start",
    "browser.open_url",
    "github.read_watch",
    "github.discussions",
    "github.actions.dispatch",
    "github.actions.cancel",
    "github.actions.rerun",
  ]);
});
