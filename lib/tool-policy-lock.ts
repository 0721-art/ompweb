import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "./omp/paths";
import type { CapabilityId } from "./tool-access-policy";

export function withToolPolicyLock<T>(run: (lock: DatabaseSync) => T): T {
  const path = resolve(getAgentDir(), "omp-web-settings.lock.sqlite");
  mkdirSync(resolve(path, ".."), { recursive: true });
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
  const lock = new DatabaseSync(path);
  try {
    lock.exec("PRAGMA busy_timeout = 5000");
    lock.exec("CREATE TABLE IF NOT EXISTS tool_policy_generations (capability TEXT PRIMARY KEY, generation INTEGER NOT NULL)");
    lock.exec(`CREATE TABLE IF NOT EXISTS tool_approval_generations (
      session_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      capability TEXT NOT NULL,
      generation INTEGER NOT NULL,
      PRIMARY KEY (session_id, resource_type, resource_key, capability)
    )`);
    lock.exec("CREATE TABLE IF NOT EXISTS tool_approval_clear_generation (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), generation INTEGER NOT NULL)");
    lock.exec("BEGIN IMMEDIATE");
    const result = run(lock);
    lock.exec("COMMIT");
    return result;
  } catch (error) {
    if (lock.isTransaction) lock.exec("ROLLBACK");
    throw error;
  } finally {
    lock.close();
  }
}

export function readToolPolicyGeneration(lock: DatabaseSync, capability: CapabilityId): number {
  const row = lock.prepare("SELECT generation FROM tool_policy_generations WHERE capability = ?").get(capability) as { generation: number | bigint } | undefined;
  return Number(row?.generation ?? 0);
}

export function bumpToolPolicyGeneration(lock: DatabaseSync, capability: CapabilityId): number {
  lock.prepare("INSERT INTO tool_policy_generations (capability, generation) VALUES (?, 1) ON CONFLICT(capability) DO UPDATE SET generation = generation + 1").run(capability);
  return readToolPolicyGeneration(lock, capability);
}

export function currentToolPolicyGeneration(capability: CapabilityId): number {
  return withToolPolicyLock((lock) => readToolPolicyGeneration(lock, capability));
}

export function readToolApprovalGeneration(
  lock: DatabaseSync,
  sessionId: string,
  resourceType: string,
  resourceKey: string,
  capability: CapabilityId,
): number {
  const row = lock.prepare(`
    SELECT generation FROM tool_approval_generations
    WHERE session_id = ? AND resource_type = ? AND resource_key = ? AND capability = ?
  `).get(sessionId, resourceType, resourceKey, capability) as { generation: number | bigint } | undefined;
  return Number(row?.generation ?? 0);
}

export function bumpToolApprovalGeneration(
  lock: DatabaseSync,
  sessionId: string,
  resourceType: string,
  resourceKey: string,
  capability: CapabilityId,
): number {
  lock.prepare(`
    INSERT INTO tool_approval_generations (session_id, resource_type, resource_key, capability, generation)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(session_id, resource_type, resource_key, capability)
    DO UPDATE SET generation = generation + 1
  `).run(sessionId, resourceType, resourceKey, capability);
  return readToolApprovalGeneration(lock, sessionId, resourceType, resourceKey, capability);
}

export function readToolApprovalClearGeneration(lock: DatabaseSync): number {
  const row = lock.prepare("SELECT generation FROM tool_approval_clear_generation WHERE singleton = 1").get() as { generation: number | bigint } | undefined;
  return Number(row?.generation ?? 0);
}

export function bumpToolApprovalClearGeneration(lock: DatabaseSync): number {
  lock.prepare(`
    INSERT INTO tool_approval_clear_generation (singleton, generation) VALUES (1, 1)
    ON CONFLICT(singleton) DO UPDATE SET generation = generation + 1
  `).run();
  return readToolApprovalClearGeneration(lock);
}
