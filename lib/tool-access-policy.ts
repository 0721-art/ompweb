export const CAPABILITY_IDS = [
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
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];
export type ConfirmationPolicy = "ask" | "allow";

export interface OperationPolicy {
  enabled: boolean;
  confirmation: ConfirmationPolicy;
}

type PolicyMap = Partial<Record<CapabilityId, OperationPolicy>>;

export interface ToolPolicies {
  version: 1;
  global: PolicyMap;
  modelRoles: Record<string, PolicyMap>;
  agents: Record<string, PolicyMap>;
}

export const EMPTY_TOOL_POLICIES: ToolPolicies = {
  version: 1,
  global: {},
  modelRoles: {},
  agents: {},
};

export interface ResolveToolPolicyInput {
  capability: CapabilityId;
  policies: ToolPolicies;
  global: OperationPolicy;
  caller?: { agentId?: string; modelRole?: string };
  target?: OperationPolicy;
}

export interface ResolvedToolPolicy {
  caller: OperationPolicy;
  target: OperationPolicy | undefined;
  allowed: boolean;
}

export function resolveToolPolicy(input: ResolveToolPolicyInput): ResolvedToolPolicy {
  const { capability, policies, global, caller: provenance, target } = input;
  const caller = (provenance?.agentId ? policies.agents[provenance.agentId]?.[capability] : undefined)
    ?? (provenance?.modelRole ? policies.modelRoles[provenance.modelRole]?.[capability] : undefined)
    ?? policies.global[capability]
    ?? global;
  return { caller, target, allowed: caller.enabled && target?.enabled !== false };
}
