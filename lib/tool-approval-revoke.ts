import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "./omp/paths";
import type { CapabilityId } from "./tool-access-policy";

export function revokeToolApprovalResource(resourceType: string, resourceKey: string, capability: CapabilityId): number {
  const path = join(getAgentDir(), "omp-web", "tool-approvals.sqlite");
  if (!existsSync(path)) return 0;
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    return Number(database.prepare("DELETE FROM grants WHERE resource_type = ? AND resource_key = ? AND capability = ?")
      .run(resourceType, resourceKey, capability).changes);
  } finally {
    database.close();
  }
}
