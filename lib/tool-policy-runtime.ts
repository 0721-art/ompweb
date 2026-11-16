import { grant, has, revoke } from "./tool-approval-store";
import { resolveToolPolicy, type CapabilityId, type OperationPolicy } from "./tool-access-policy";
import { readWebServerSettingsFromDisk } from "./web-settings";
import { readToolPolicyGeneration, withToolPolicyLock } from "./tool-policy-lock";

export interface ToolCaller {
  agentId?: string;
  modelRole?: string;
}

export interface AuthorizeToolCapabilityInput {
  capability: CapabilityId;
  sessionId: string | (() => string);
  capabilityLabel: string;
  confirm(message: string): Promise<boolean>;
  resourceType?: string;
  resourceKey?: string;
  caller?: ToolCaller;
  target?: OperationPolicy | (() => OperationPolicy | undefined);
  signal?: AbortSignal;
}

export type DeferredToolAuthorizationInput = Omit<AuthorizeToolCapabilityInput, "confirm">;
export type DeferredToolAuthorization = "authorized" | "confirmation_required";

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

const currentSessionId = (input: AuthorizeToolCapabilityInput): string =>
  typeof input.sessionId === "function" ? input.sessionId() : input.sessionId;

const currentTarget = (input: AuthorizeToolCapabilityInput): OperationPolicy | undefined =>
  typeof input.target === "function" ? input.target() : input.target;

function resolved(input: AuthorizeToolCapabilityInput) {
  try {
    const policies = readWebServerSettingsFromDisk().toolPolicies;
    return resolveToolPolicy({
      capability: input.capability,
      policies,
      global: DENY,
      caller: validateToolCaller(input.caller),
      target: currentTarget(input),
    });
  } catch {
    return resolveToolPolicy({ capability: input.capability, policies: { version: 1, global: {}, modelRoles: {}, agents: {} }, global: DENY, target: currentTarget(input) });
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

export function hasToolCapabilityAuthorization(
  capability: CapabilityId,
  sessionId: string,
  resourceType: string,
  resourceKey: string,
  caller?: ToolCaller,
  policyGeneration?: number,
): boolean {
  return withToolPolicyLock((lock) => {
    if (policyGeneration !== undefined && readToolPolicyGeneration(lock, capability) !== policyGeneration) return false;
    const policy = resolved({ capability, caller, sessionId, capabilityLabel: capability, confirm: async () => false });
    return policy.allowed && (policy.caller.confirmation === "allow" || has(sessionId, resourceType, resourceKey, capability));
  });
}

const deferredInput = (input: DeferredToolAuthorizationInput): AuthorizeToolCapabilityInput => ({
  ...input,
  confirm: async () => false,
});

/** Resolve policy without asking. The caller must later finalize a confirmed request through confirmToolCapability. */
export function resolveDeferredToolAuthorization(input: DeferredToolAuthorizationInput): DeferredToolAuthorization {
  validateToolCaller(input.caller);
  return withToolPolicyLock(() => {
    if (input.signal?.aborted) throw new Error("The tool request was cancelled before authorization.");
    const authorization = deferredInput(input);
    const policy = resolved(authorization);
    if (policy.target?.enabled === false) throw new Error(`The target ${input.resourceKey ?? "resource"} denies ${input.capabilityLabel}.`);
    if (!policy.allowed) throw new Error(`${input.capabilityLabel} is disabled by tool policy.`);
    if (policy.caller.confirmation === "allow" && policy.target?.confirmation !== "ask") return "authorized";
    const sessionId = currentSessionId(authorization);
    return input.capability !== "omp.bash" && input.resourceType !== undefined && input.resourceKey !== undefined
      && has(sessionId, input.resourceType, input.resourceKey, input.capability)
      ? "authorized"
      : "confirmation_required";
  });
}

/** Finalize an externally confirmed deferred request while its server-owned pending identity still exists. */
export function confirmToolCapability(
  input: DeferredToolAuthorizationInput,
  isPending: () => boolean,
): { sessionId: string; granted: boolean } {
  validateToolCaller(input.caller);
  return withToolPolicyLock(() => {
    if (!isPending()) throw new Error("The tool request is no longer pending.");
    if (input.signal?.aborted) throw new Error("The tool request was cancelled before approval was granted.");
    const authorization = deferredInput(input);
    const current = resolved(authorization);
    if (current.target?.enabled === false) throw new Error(`The target ${input.resourceKey ?? "resource"} denies ${input.capabilityLabel}.`);
    if (!current.allowed) throw new Error(`${input.capabilityLabel} is disabled by tool policy.`);
    const sessionId = currentSessionId(authorization);
    const confirmationRequired = current.caller.confirmation === "ask" || current.target?.confirmation === "ask";
    const remembers = confirmationRequired && input.capability !== "omp.bash"
      && input.resourceType !== undefined && input.resourceKey !== undefined;
    const granted = remembers && !has(sessionId, input.resourceType!, input.resourceKey!, input.capability);
    if (granted) grant(sessionId, input.resourceType!, input.resourceKey!, input.capability);
    return { sessionId, granted };
  });
}

/** Remove only the grant created by a confirmed request whose browser execution subsequently failed. */
export function revokeConfirmedToolCapability(
  input: DeferredToolAuthorizationInput,
  grantedSessionId: string,
  isPending: () => boolean,
): void {
  withToolPolicyLock(() => {
    if (!isPending() || input.resourceType === undefined || input.resourceKey === undefined) return;
    revoke(grantedSessionId, input.resourceType, input.resourceKey, input.capability);
    const current = currentSessionId(deferredInput(input));
    if (current !== grantedSessionId) revoke(current, input.resourceType, input.resourceKey, input.capability);
  });
}

export async function authorizeToolCapability(input: AuthorizeToolCapabilityInput): Promise<void> {
  validateToolCaller(input.caller);
  const initial = withToolPolicyLock(() => {
    if (input.signal?.aborted) throw new Error("The tool request was cancelled before authorization.");
    const policy = resolved(input);
    if (policy.target?.enabled === false) throw new Error(`The target ${input.resourceKey ?? "resource"} denies ${input.capabilityLabel}.`);
    if (!policy.allowed) throw new Error(`${input.capabilityLabel} is disabled by tool policy.`);
    if (policy.caller.confirmation === "allow" && policy.target?.confirmation !== "ask") return "allowed";
    const sessionId = currentSessionId(input);
    if (input.capability !== "omp.bash" && input.resourceType !== undefined && input.resourceKey !== undefined
      && has(sessionId, input.resourceType, input.resourceKey, input.capability)) return "allowed";
    return "confirm";
  });
  if (input.signal?.aborted) throw new Error("The tool request was cancelled before authorization.");
  if (initial === "allowed") return;

  const remembers = input.capability !== "omp.bash" && input.resourceType !== undefined && input.resourceKey !== undefined;
  const sessionId = currentSessionId(input);
  const scope = remembers
    ? `${input.resourceType} ${input.resourceKey} for session ${sessionId}; this approval is remembered only for this session`
    : `session ${sessionId}; this capability asks every time`;
  if (!(await input.confirm(`Allow ${input.capabilityLabel} for ${scope}?`))) throw new Error(`The user declined ${input.capabilityLabel}.`);
  if (input.signal?.aborted) throw new Error("The tool request was cancelled before approval was granted.");
  withToolPolicyLock(() => {
    if (input.signal?.aborted) throw new Error("The tool request was cancelled before approval was granted.");
    const current = resolved(input);
    if (current.target?.enabled === false) throw new Error(`The target ${input.resourceKey ?? "resource"} denies ${input.capabilityLabel}.`);
    if (!current.allowed) throw new Error(`${input.capabilityLabel} is disabled by tool policy.`);
    const confirmationRequired = current.caller.confirmation === "ask" || current.target?.confirmation === "ask";
    if (!confirmationRequired) return;
    if (remembers) grant(currentSessionId(input), input.resourceType!, input.resourceKey!, input.capability);
  });
}
