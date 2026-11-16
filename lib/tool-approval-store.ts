import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CAPABILITY_IDS, type CapabilityId } from "./tool-access-policy";
import { getAgentDir } from "./omp/paths";
import { isRecord } from "./type-guards";

export interface ToolApprovalGrant {
  sessionId: string;
  resourceType: string;
  resourceKey: string;
  capability: CapabilityId;
}

declare global {
  var __ompToolApprovalStore: { path: string; db: Database } | undefined;
}

const MAX_SESSION_ID_LENGTH = 256;
const MAX_RESOURCE_TYPE_LENGTH = 64;
const MAX_RESOURCE_KEY_LENGTH = 2048;
const RESOURCE_TYPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_KEYS = { prototype: true, constructor: true } as const;
const LEGACY_MIGRATION = "github-read-grants-v1";

const storeDir = (): string => join(getAgentDir(), "omp-web");
const storePath = (): string => join(storeDir(), "tool-approvals.sqlite");
const legacyGithubPath = (): string => join(storeDir(), "github-watches.sqlite");

function legacyGithubStoreExists(): boolean {
  const path = legacyGithubPath();
  return existsSync(path) && statSync(path).isFile();
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}

export function isToolApprovalGrant(value: unknown): value is ToolApprovalGrant {
  if (!isRecord(value) || Object.keys(value).length !== 4) return false;
  return validText(value.sessionId, MAX_SESSION_ID_LENGTH)
    && validText(value.resourceType, MAX_RESOURCE_TYPE_LENGTH)
    && RESOURCE_TYPE.test(value.resourceType)
    && !Object.hasOwn(RESERVED_KEYS, value.resourceType)
    && validText(value.resourceKey, MAX_RESOURCE_KEY_LENGTH)
    && typeof value.capability === "string"
    && CAPABILITY_IDS.includes(value.capability as CapabilityId);
}

function checked(sessionId: string, resourceType: string, resourceKey: string, capability: CapabilityId): ToolApprovalGrant {
  const identity = { sessionId, resourceType, resourceKey, capability };
  if (!isToolApprovalGrant(identity)) throw new TypeError("Invalid tool approval grant identity");
  return identity;
}

function checkedSessionId(sessionId: string): string {
  if (!validText(sessionId, MAX_SESSION_ID_LENGTH)) throw new TypeError("Invalid session id");
  return sessionId;
}

function checkedCapability(capability: CapabilityId): CapabilityId {
  if (!CAPABILITY_IDS.includes(capability)) throw new TypeError("Invalid capability");
  return capability;
}

function transaction<T>(database: Database, run: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function migrateLegacyGithubGrants(database: Database): void {
  if (database.prepare("SELECT 1 FROM migrations WHERE name = ?").get(LEGACY_MIGRATION)) return;
  const path = legacyGithubPath();
  if (!legacyGithubStoreExists()) return;

  const legacy = new Database(path, { readonly: true });
  let rows: Array<{ session_id: string; repo_key: string }>;
  try {
    const table = legacy.prepare<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'read_grants'").get();
    if (!table) return;
    rows = legacy.prepare<{ session_id: string; repo_key: string }, []>("SELECT session_id, repo_key FROM read_grants").all();
  } finally {
    legacy.close(true);
  }

  transaction(database, () => {
    const insert = database.prepare("INSERT OR IGNORE INTO grants (session_id, resource_type, resource_key, capability) VALUES (?, 'github.repository', ?, 'github.read_watch')");
    for (const row of rows) {
      if (isToolApprovalGrant({ sessionId: row.session_id, resourceType: "github.repository", resourceKey: row.repo_key, capability: "github.read_watch" })) {
        insert.run(row.session_id, row.repo_key);
      }
    }
    database.prepare("INSERT OR IGNORE INTO migrations (name) VALUES (?)").run(LEGACY_MIGRATION);
  });
}

function open(dir: string, path: string): Database {
  mkdirSync(dir, { recursive: true });
  const database = new Database(path);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    for (let attempt = 0; ; attempt++) {
      try {
        database.exec("PRAGMA journal_mode = WAL");
        break;
      } catch (error) {
        if (!isRecord(error) || error.errno !== 5 || attempt >= 250) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS grants (
        session_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        capability TEXT NOT NULL,
        PRIMARY KEY (session_id, resource_type, resource_key, capability)
      );
      CREATE INDEX IF NOT EXISTS grants_capability ON grants (capability);
      CREATE TABLE IF NOT EXISTS migrations (name TEXT NOT NULL PRIMARY KEY);
    `);
    migrateLegacyGithubGrants(database);
    return database;
  } catch (error) {
    database.close(true);
    throw error;
  }
}

function db(): Database {
  const path = storePath();
  const cached = globalThis.__ompToolApprovalStore;
  if (cached?.path === path) return cached.db;
  const database = open(storeDir(), path);
  closeToolApprovalStore();
  globalThis.__ompToolApprovalStore = { path, db: database };
  return database;
}

function existingDb(): Database | undefined {
  return globalThis.__ompToolApprovalStore?.path === storePath() || existsSync(storePath()) || legacyGithubStoreExists() ? db() : undefined;
}

/** Finalizes prepared statements so Windows can release the SQLite file. */
export function closeToolApprovalStore(): void {
  globalThis.__ompToolApprovalStore?.db.close(true);
  globalThis.__ompToolApprovalStore = undefined;
}

export function has(sessionId: string, resourceType: string, resourceKey: string, capability: CapabilityId): boolean {
  const key = checked(sessionId, resourceType, resourceKey, capability);
  return db().prepare("SELECT 1 FROM grants WHERE session_id = ? AND resource_type = ? AND resource_key = ? AND capability = ?").get(
    key.sessionId, key.resourceType, key.resourceKey, key.capability,
  ) !== null;
}

export function grant(sessionId: string, resourceType: string, resourceKey: string, capability: CapabilityId): void {
  const key = checked(sessionId, resourceType, resourceKey, capability);
  db().prepare("INSERT OR IGNORE INTO grants (session_id, resource_type, resource_key, capability) VALUES (?, ?, ?, ?)").run(
    key.sessionId, key.resourceType, key.resourceKey, key.capability,
  );
}

type GrantRow = { session_id: string; resource_type: string; resource_key: string; capability: CapabilityId };

export function list(): ToolApprovalGrant[] {
  return db().prepare<GrantRow, []>(`
    SELECT session_id, resource_type, resource_key, capability FROM grants
    ORDER BY session_id, resource_type, resource_key, capability
  `).all().map((row) => ({ sessionId: row.session_id, resourceType: row.resource_type, resourceKey: row.resource_key, capability: row.capability }));
}

export function revoke(sessionId: string, resourceType: string, resourceKey: string, capability: CapabilityId): boolean {
  const key = checked(sessionId, resourceType, resourceKey, capability);
  const database = existingDb();
  if (!database) return false;
  return database.prepare("DELETE FROM grants WHERE session_id = ? AND resource_type = ? AND resource_key = ? AND capability = ?").run(
    key.sessionId, key.resourceType, key.resourceKey, key.capability,
  ).changes > 0;
}

export function revokeCapability(capability: CapabilityId): number {
  checkedCapability(capability);
  return existingDb()?.prepare("DELETE FROM grants WHERE capability = ?").run(capability).changes ?? 0;
}

export function clear(): number {
  return existingDb()?.prepare("DELETE FROM grants").run().changes ?? 0;
}

export function removeSession(sessionId: string): void {
  checkedSessionId(sessionId);
  existingDb()?.prepare("DELETE FROM grants WHERE session_id = ?").run(sessionId);
}

export function renameSession(oldId: string, newId: string): void {
  checkedSessionId(oldId);
  checkedSessionId(newId);
  if (oldId === newId) return;
  const database = existingDb();
  if (!database) return;
  transaction(database, () => {
    database.prepare(`
      INSERT OR IGNORE INTO grants (session_id, resource_type, resource_key, capability)
      SELECT ?, resource_type, resource_key, capability FROM grants WHERE session_id = ?
    `).run(newId, oldId);
    database.prepare("DELETE FROM grants WHERE session_id = ?").run(oldId);
  });
}
