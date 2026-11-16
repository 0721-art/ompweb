import { grant, has } from "./tool-approval-store";
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
export interface DeferredToolAuthorizationResolution {
  authorization: DeferredToolAuthorization;
  generation: number;
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

/** Resolve policy without asking and bind the routed event to the current policy generation. */
export function resolveDeferredToolAuthorization(input: DeferredToolAuthorizationInput): DeferredToolAuthorizationResolution {
  validateToolCaller(input.caller);
  return withToolPolicyLock((lock) => {
    if (input.signal?.aborted) throw new Error("The tool request was cancelled before authorization.");
    const authorization = deferredInput(input);
    const policy = resolved(authorization);
    if (policy.target?.enabled === false) throw new Error(`The target ${input.resourceKey ?? "resource"} denies ${input.capabilityLabel}.`);
    if (!policy.allowed) throw new Error(`${input.capabilityLabel} is disabled by tool policy.`);
    const generation = readToolPolicyGeneration(lock, input.capability);
    if (policy.caller.confirmation === "allow" && policy.target?.confirmation !== "ask") {
      return { authorization: "authorized", generation };
    }
    const sessionId = currentSessionId(authorization);
    const state = input.capability !== "omp.bash" && input.resourceType !== undefined && input.resourceKey !== undefined
      && has(sessionId, input.resourceType, input.resourceKey, input.capability)
      ? "authorized"
      : "confirmation_required";
    return { authorization: state, generation };
  });
}

/** Atomically claim one pending browser action without persisting remembered authority. */
export function claimDeferredToolAuthorization(
  input: DeferredToolAuthorizationInput,
  expectedGeneration: number,
  userConfirmed: boolean,
  isPending: () => boolean,
): { sessionId: string; generation: number; rememberOnSuccess: boolean } {
  validateToolCaller(input.caller);
  return withToolPolicyLock((lock) => {
    if (!isPending()) throw new Error("The tool request is no longer pending.");
    if (input.signal?.aborted) throw new Error("The tool request was cancelled before authorization.");
    const generation = readToolPolicyGeneration(lock, input.capability);
    if (generation !== expectedGeneration) throw new Error("The browser URL authorization changed before execution was claimed.");
    const authorization = deferredInput(input);
    const current = resolved(authorization);
    if (current.target?.enabled === false) throw new Error(`The target ${input.resourceKey ?? "resource"} denies ${input.capabilityLabel}.`);
    if (!current.allowed) throw new Error(`${input.capabilityLabel} is disabled by tool policy.`);
    const sessionId = currentSessionId(authorization);
    const hasGrant = input.resourceType !== undefined && input.resourceKey !== undefined
      && has(sessionId, input.resourceType, input.resourceKey, input.capability);
    const confirmationRequired = current.caller.confirmation === "ask" || current.target?.confirmation === "ask";
    if (!userConfirmed && confirmationRequired && !hasGrant) {
      throw new Error("The browser URL authorization changed before execution was claimed.");
    }
    return { sessionId, generation, rememberOnSuccess: userConfirmed && confirmationRequired && !hasGrant };
  });
}

/** Persist a remembered grant only after the claimed browser action actually succeeds. */
export function promoteClaimedToolApproval(
  input: DeferredToolAuthorizationInput,
  claimedSessionId: string,
  expectedGeneration: number,
  isPending: () => boolean,
): void {
  withToolPolicyLock((lock) => {
    if (!isPending() || input.resourceType === undefined || input.resourceKey === undefined) {
      throw new Error("The browser URL claim is no longer pending.");
    }
    if (readToolPolicyGeneration(lock, input.capability) !== expectedGeneration) return;
    const current = resolved(deferredInput(input));
    const confirmationRequired = current.allowed
      && (current.caller.confirmation === "ask" || current.target?.confirmation === "ask");
    if (confirmationRequired) grant(claimedSessionId, input.resourceType, input.resourceKey, input.capability);
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
