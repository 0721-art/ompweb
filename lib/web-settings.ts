import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";
import { BROWSER_TRANSPORTS, type BrowserTransport, type BrowserTransportState } from "./event-stream-protocol";
import { DEFAULT_UPLOAD_RETENTION_DAYS, isUploadRetentionDays } from "./upload-limits";
import { isRecord } from "./type-guards";
import {
  CAPABILITY_IDS,
  type CapabilityId,
  type OperationPolicy,
  type ToolPolicies,
} from "./tool-access-policy";

/** omp-web's own server-side settings (omp's config.yml stays omp's). */
export interface WebServerSettings {
  /** Resume sessions that were mid-run when omp-web stopped. */
  autoResumeSessions: boolean;
  /** Transitional type-only field for callers migrated in Task 4; absent at runtime and never persisted. */
  agentToolsEnabled: boolean;
  /** Versioned capability and confirmation policies owned by omp-web. */
  toolPolicies: ToolPolicies;
  /**
   * Environment variables merged into the `omp` child process (issue #104).
   * Stored as a validated record; lib/omp/agent-env.ts owns the policy and
   * re-checks every name before handing it to a spawn.
   */
  agentEnv: Record<string, string>;
  /** Live-event transport the browser uses; "ws" unless the file says "sse" (a missing or unknown value, the experiment's ws-* values included, reads as "ws"). */
  browserTransport: BrowserTransport;
  /** Days a sent upload stays in its session's `local://uploads/` on every host; `null` keeps them for ever (docs/specs/2026-11-02-file-uploads-design.md, U6). */
  uploadRetentionDays: number | null;
}

const ASK: OperationPolicy = { enabled: true, confirmation: "ask" };
const ALLOW: OperationPolicy = { enabled: true, confirmation: "allow" };
const DENY: OperationPolicy = { enabled: false, confirmation: "ask" };

const DEFAULT_TOOL_POLICIES: ToolPolicies = {
  version: 1,
  global: {
    "ompweb.agent_tools": DENY,
    "ompweb.session_start": ASK,
    "browser.open_url": ALLOW,
    "github.read_watch": ASK,
    "github.discussions": ASK,
    "github.actions.dispatch": ASK,
    "github.actions.cancel": ASK,
    "github.actions.rerun": ASK,
  },
  modelRoles: {},
  agents: {},
};

const CLOSED_TOOL_POLICIES: ToolPolicies = {
  version: 1,
  global: Object.fromEntries(CAPABILITY_IDS.map((capability) => [capability, DENY])),
  modelRoles: {},
  agents: {},
};

const DEFAULTS = {
  autoResumeSessions: false,
  toolPolicies: DEFAULT_TOOL_POLICIES,
  agentEnv: {},
  browserTransport: "ws",
  uploadRetentionDays: DEFAULT_UPLOAD_RETENTION_DAYS,
} as WebServerSettings;

/** What every hello and `transport` frame tells the browser. */
export function browserTransportState(settings = loadWebServerSettings()): BrowserTransportState {
  return { transport: settings.browserTransport };
}

/** String-valued entries only — the allow-list lives in lib/omp/agent-env.ts. */
function readAgentEnvRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const entries: Array<[string, string]> = [];
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string") entries.push([name, entry]);
  }
  return Object.fromEntries(entries);
}


function operationPolicy(value: unknown, allowInherit = false): OperationPolicy | "inherit" {
  if (allowInherit && value === "inherit") return value;
  if (!isRecord(value) || typeof value.enabled !== "boolean" || (value.confirmation !== "ask" && value.confirmation !== "allow") || Object.keys(value).some((key) => key !== "enabled" && key !== "confirmation")) {
    throw new Error("Invalid tool operation policy.");
  }
  return { enabled: value.enabled, confirmation: value.confirmation };
}

function capabilityMap(value: unknown, allowInherit = false): Partial<Record<CapabilityId, OperationPolicy | "inherit">> {
  if (!isRecord(value)) throw new Error("Tool capability policies must be an object.");
  const result: Partial<Record<CapabilityId, OperationPolicy | "inherit">> = {};
  for (const [capability, policy] of Object.entries(value)) {
    if (!CAPABILITY_IDS.includes(capability as CapabilityId)) throw new Error(`Unknown tool capability: ${capability}.`);
    result[capability as CapabilityId] = operationPolicy(policy, allowInherit);
  }
  return result;
}

function scopedPolicies(value: unknown, allowInherit = false): Record<string, Partial<Record<CapabilityId, OperationPolicy | "inherit">>> {
  if (!isRecord(value)) throw new Error("Scoped tool policies must be an object.");
  return Object.fromEntries(Object.entries(value).map(([id, policies]) => {
    if (!id) throw new Error("Tool policy scope IDs must not be empty.");
    return [id, capabilityMap(policies, allowInherit)];
  }));
}

export function parseToolPolicies(value: unknown): ToolPolicies {
  if (!isRecord(value) || value.version !== 1 || Object.keys(value).some((key) => !["version", "global", "modelRoles", "agents"].includes(key))) {
    throw new Error("Invalid tool policy storage.");
  }
  return {
    version: 1,
    global: capabilityMap(value.global) as ToolPolicies["global"],
    modelRoles: scopedPolicies(value.modelRoles) as ToolPolicies["modelRoles"],
    agents: scopedPolicies(value.agents) as ToolPolicies["agents"],
  };
}

function legacyActionPolicy(value: unknown): OperationPolicy {
  return value === "deny" ? DENY : value === "allow" ? ALLOW : ASK;
}

function migrateToolPolicies(raw: Record<string, unknown>): ToolPolicies {
  if (raw.toolPolicies !== undefined) return parseToolPolicies(raw.toolPolicies);
  const actions = isRecord(raw.githubActionsPermissions) ? raw.githubActionsPermissions : {};
  return {
    version: 1,
    global: {
      ...DEFAULT_TOOL_POLICIES.global,
      "ompweb.agent_tools": raw.agentToolsEnabled === true ? ALLOW : DENY,
      "github.discussions": raw.githubWritesUnasked === true ? ALLOW : ASK,
      "github.actions.dispatch": legacyActionPolicy(actions.dispatch),
      "github.actions.cancel": legacyActionPolicy(actions.cancel),
      "github.actions.rerun": legacyActionPolicy(actions.rerun),
    },
    modelRoles: {},
    agents: {},
  };
}

function settingsPath(): string {
  return resolve(getAgentDir(), "omp-web-settings.json");
}

function settingsLockPath(): string {
  return resolve(getAgentDir(), "omp-web-settings.lock.sqlite");
}

function normalizeSettings(raw: Record<string, unknown>): WebServerSettings {
  return {
    autoResumeSessions: raw.autoResumeSessions === true,
    toolPolicies: migrateToolPolicies(raw),
    agentEnv: readAgentEnvRecord(raw.agentEnv),
    browserTransport: BROWSER_TRANSPORTS.find((transport) => transport === raw.browserTransport) ?? "ws",
    uploadRetentionDays: isUploadRetentionDays(raw.uploadRetentionDays) ? raw.uploadRetentionDays : DEFAULT_UPLOAD_RETENTION_DAYS,
  } as WebServerSettings;
}

function parseSettingsRecord(text: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error("The settings file must contain a JSON object.");
  return raw;
}

function freshSettingsRecord(): Record<string, unknown> | null {
  try {
    return parseSettingsRecord(readFileSync(settingsPath(), "utf8"));
  } catch {
    return null;
  }
}

/** Permission reconciliation must use current disk state rather than another process's cached value. */
export function readWebServerSettingsFromDisk(): WebServerSettings {
  try {
    return normalizeSettings(parseSettingsRecord(readFileSync(settingsPath(), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULTS;
    throw error;
  }
}

declare global {
  // Survives `bun --hot` re-evaluation, which creates fresh module instances.
  var __ompWebSettingsCache: { path: string; settings: WebServerSettings } | undefined;
}

export function loadWebServerSettings(): WebServerSettings {
  const path = settingsPath();
  const cached = globalThis.__ompWebSettingsCache;
  if (cached?.path === path) return cached.settings;
  let settings = DEFAULTS;
  try {
    if (existsSync(path)) settings = normalizeSettings(parseSettingsRecord(readFileSync(path, "utf8")));
  } catch {
    settings = { ...DEFAULTS, toolPolicies: CLOSED_TOOL_POLICIES };
  }
  globalThis.__ompWebSettingsCache = { path, settings };
  return settings;
}

function freshToolPolicies(): ToolPolicies | null {
  const raw = freshSettingsRecord();
  return raw ? migrateToolPolicies(raw) : null;
}

/** Fresh compatibility readers used until enforcement adapters consume the shared resolver. */
export function readAgentToolsEnabledFromDisk(): boolean {
  try {
    return freshToolPolicies()?.global["ompweb.agent_tools"]?.enabled === true;
  } catch {
    return false;
  }
}

export function readGithubWritesUnaskedFromDisk(): boolean {
  try {
    const policy = freshToolPolicies()?.global["github.discussions"];
    return policy?.enabled === true && policy.confirmation === "allow";
  } catch {
    return false;
  }
}

export type GithubActionsOperation = "dispatch" | "cancel" | "rerun";
export type GithubActionsPermission = "deny" | "ask" | "allow";
export type GithubActionsPermissions = Record<GithubActionsOperation, GithubActionsPermission>;

export function readGithubActionsPermissionFromDisk(operation: GithubActionsOperation): GithubActionsPermission {
  try {
    const policy = freshToolPolicies()?.global[`github.actions.${operation}`];
    return !policy?.enabled ? "deny" : policy.confirmation;
  } catch {
    return "deny";
  }
}

export function parseToolPoliciesPatch(value: unknown): ToolPoliciesPatch {
  if (!isRecord(value) || Object.keys(value).some((key) => !["version", "global", "modelRoles", "agents"].includes(key)) || (value.version !== undefined && value.version !== 1)) {
    throw new Error("toolPolicies must be a version 1 policy object.");
  }
  return {
    ...(value.version === 1 ? { version: 1 as const } : {}),
    ...(value.global === undefined ? {} : { global: capabilityMap(value.global) as ToolPoliciesPatch["global"] }),
    ...(value.modelRoles === undefined ? {} : { modelRoles: scopedPolicies(value.modelRoles, true) }),
    ...(value.agents === undefined ? {} : { agents: scopedPolicies(value.agents, true) }),
  };
}

type ToolPolicyPatchMap = Partial<Record<CapabilityId, OperationPolicy | "inherit">>;
export interface ToolPoliciesPatch {
  version?: 1;
  global?: Partial<Record<CapabilityId, OperationPolicy>>;
  modelRoles?: Record<string, ToolPolicyPatchMap>;
  agents?: Record<string, ToolPolicyPatchMap>;
}

type WebServerSettingsPatch = Omit<Partial<WebServerSettings>, "toolPolicies"> & {
  toolPolicies?: ToolPoliciesPatch;
};

function mergeScopedPolicies(current: ToolPolicies["modelRoles"], patch: Record<string, ToolPolicyPatchMap> | undefined): ToolPolicies["modelRoles"] {
  const merged = structuredClone(current);
  for (const [id, changes] of Object.entries(patch ?? {})) {
    const scope = { ...(merged[id] ?? {}) };
    for (const [capability, policy] of Object.entries(changes) as Array<[CapabilityId, OperationPolicy | "inherit"]>) {
      if (policy === "inherit") delete scope[capability];
      else scope[capability] = policy;
    }
    if (Object.keys(scope).length) merged[id] = scope;
    else delete merged[id];
  }
  return merged;
}

function mergeToolPolicies(current: ToolPolicies, patch: ToolPoliciesPatch | undefined): ToolPolicies {
  if (!patch) return current;
  return {
    version: 1,
    global: { ...current.global, ...patch.global },
    modelRoles: mergeScopedPolicies(current.modelRoles, patch.modelRoles),
    agents: mergeScopedPolicies(current.agents, patch.agents),
  };
}
/** Atomic write (temp file + rename), like the project registry. Private to its user: it holds agentEnv. */
export function saveWebServerSettings(patch: WebServerSettingsPatch): WebServerSettings {
  const path = settingsPath();
  mkdirSync(resolve(path, ".."), { recursive: true });
  const lockPath = settingsLockPath();
  closeSync(openSync(lockPath, "a", 0o600));
  chmodSync(lockPath, 0o600);
  const lock = new DatabaseSync(lockPath);
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    lock.exec("PRAGMA busy_timeout = 5000");
    lock.exec("BEGIN IMMEDIATE");
    const current = readWebServerSettingsFromDisk();
    const settings = {
      ...current,
      ...patch,
      toolPolicies: mergeToolPolicies(current.toolPolicies, patch.toolPolicies),
    };
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
    globalThis.__ompWebSettingsCache = { path, settings };
    lock.exec("COMMIT");
    return settings;
  } catch (error) {
    if (lock.isTransaction) lock.exec("ROLLBACK");
    throw error;
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
    lock.close();
  }
}
