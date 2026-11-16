import type { OperationPolicy } from "./tool-access-policy";

/** The host rule shared by agent-tools.ts and github/tools.ts; a leaf module so neither imports the other at runtime. */

/** A machine sessions can start on; this machine has id "local". */
export interface AgentToolHost {
  id: string;
  label: string;
  online: boolean;
  /** Mandatory policy owned by the target host. */
  agentStartPolicy: OperationPolicy;
}

export function hostStartsUnasked(target: AgentToolHost): boolean {
  return target.agentStartPolicy.enabled && target.agentStartPolicy.confirmation === "allow";
}
