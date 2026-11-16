import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "./omp/paths";

export function withToolPolicyLock<T>(run: () => T): T {
  const path = resolve(getAgentDir(), "omp-web-settings.lock.sqlite");
  mkdirSync(resolve(path, ".."), { recursive: true });
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
  const lock = new DatabaseSync(path);
  try {
    lock.exec("PRAGMA busy_timeout = 5000");
    lock.exec("BEGIN IMMEDIATE");
    const result = run();
    lock.exec("COMMIT");
    return result;
  } catch (error) {
    if (lock.isTransaction) lock.exec("ROLLBACK");
    throw error;
  } finally {
    lock.close();
  }
}
