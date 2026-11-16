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
