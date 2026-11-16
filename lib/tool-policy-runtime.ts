import { grant, has } from "./tool-approval-store";
import { resolveToolPolicy, type CapabilityId, type OperationPolicy } from "./tool-access-policy";
import { readWebServerSettingsFromDisk } from "./web-settings";

export interface ToolCaller {
  agentId?: string;
  modelRole?: string;
}

export interface AuthorizeToolCapabilityInput {
  capability: CapabilityId;
  sessionId: string;
  capabilityLabel: string;
  confirm(message: string): Promise<boolean>;
  resourceType?: string;
  resourceKey?: string;
  caller?: ToolCaller;
  target?: OperationPolicy;
  signal?: AbortSignal;
}

const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED: Record<string, boolean> = { __proto__: true, prototype: true, constructor: true };
const DENY: OperationPolicy = { enabled: false, confirmation: "ask" };

export function validateToolCaller(value: unknown): ToolCaller | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tool caller provenance.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "agentId" && key !== "modelRole")) throw new Error("Invalid tool caller provenance.");
  const caller: ToolCaller = {};
  for (const key of ["agentId", "modelRole"] as const) {
    const id = record[key];
    if (id === undefined) continue;
    if (typeof id !== "string" || RESERVED[id] || !SCOPE_ID.test(id)) throw new Error("Invalid tool caller provenance.");
    caller[key] = id;
  }
  return caller;
}

function resolved(input: AuthorizeToolCapabilityInput) {
  try {
    const policies = readWebServerSettingsFromDisk().toolPolicies;
    return resolveToolPolicy({
      capability: input.capability,
      policies,
      global: DENY,
      caller: validateToolCaller(input.caller),
      target: input.target,
    });
  } catch {
    return resolveToolPolicy({ capability: input.capability, policies: { version: 1, global: {}, modelRoles: {}, agents: {} }, global: DENY, target: input.target });
  }
}

export function isToolCapabilityAllowed(capability: CapabilityId, caller?: ToolCaller, target?: OperationPolicy): boolean {
  return resolved({
    capability,
    caller,
    target,
    sessionId: "",
    capabilityLabel: capability,
    confirm: async () => false,
  }).allowed;
}

export async function authorizeToolCapability(input: AuthorizeToolCapabilityInput): Promise<void> {
  validateToolCaller(input.caller);
  const policy = resolved(input);
  if (policy.target?.enabled === false) throw new Error(`The target ${input.resourceKey ?? "resource"} denies ${input.capabilityLabel}.`);
  if (!policy.allowed) throw new Error(`${input.capabilityLabel} is disabled by tool policy.`);
  if (policy.caller.confirmation === "allow" && policy.target?.confirmation !== "ask") return;

  const remembers = input.capability !== "omp.bash" && input.resourceType !== undefined && input.resourceKey !== undefined;
  if (remembers && has(input.sessionId, input.resourceType!, input.resourceKey!, input.capability)) return;
  if (input.signal?.aborted) throw new Error("The tool request was cancelled before confirmation.");
  const scope = remembers
    ? `${input.resourceType} ${input.resourceKey} for session ${input.sessionId}; this approval is remembered only for this session`
    : `session ${input.sessionId}; this capability asks every time`;
  if (!(await input.confirm(`Allow ${input.capabilityLabel} for ${scope}?`))) throw new Error(`The user declined ${input.capabilityLabel}.`);
  if (input.signal?.aborted) throw new Error("The tool request was cancelled before approval was granted.");
  const current = resolved(input);
  if (current.target?.enabled === false) throw new Error(`The target ${input.resourceKey ?? "resource"} denies ${input.capabilityLabel}.`);
  const confirmationRequired = current.caller.confirmation === "ask" || current.target?.confirmation === "ask";
  if (!current.allowed || !confirmationRequired) {
    if (current.allowed && !confirmationRequired) return;
    throw new Error(`${input.capabilityLabel} is disabled by tool policy.`);
  }
  if (remembers) grant(input.sessionId, input.resourceType!, input.resourceKey!, input.capability);
}
