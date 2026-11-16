import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getAgentDir } from "./omp/paths";
import { BROWSER_TRANSPORTS, type BrowserTransport, type BrowserTransportState } from "./event-stream-protocol";
import { DEFAULT_UPLOAD_RETENTION_DAYS, isUploadRetentionDays } from "./upload-limits";
import { isRecord } from "./type-guards";
import { revokeCapability } from "./tool-approval-store";
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
    "ompweb.session_start": ALLOW,
    "browser.open_url": ALLOW,
    "github.read_watch": ASK,
    "github.discussions": ASK,
    "github.actions.dispatch": ASK,
    "github.actions.cancel": ASK,
    "github.actions.rerun": ASK,
  },
  modelRoles: Object.create(null),
  agents: Object.create(null),
};

const CLOSED_TOOL_POLICIES: ToolPolicies = {
  version: 1,
  global: Object.fromEntries(CAPABILITY_IDS.map((capability) => [capability, DENY])),
  modelRoles: Object.create(null),
  agents: Object.create(null),
};

const DEFAULTS: WebServerSettings = {
  autoResumeSessions: false,
  toolPolicies: DEFAULT_TOOL_POLICIES,
  agentEnv: {},
  browserTransport: "ws",
  uploadRetentionDays: DEFAULT_UPLOAD_RETENTION_DAYS,
};

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
  const result: Partial<Record<CapabilityId, OperationPolicy | "inherit">> = Object.create(null);
  for (const [capability, policy] of Object.entries(value)) {
    if (!CAPABILITY_IDS.includes(capability as CapabilityId)) throw new Error(`Unknown tool capability: ${capability}.`);
    result[capability as CapabilityId] = operationPolicy(policy, allowInherit);
  }
  return result;
}

const RESERVED_SCOPE_IDS = ["__proto__", "prototype", "constructor"];
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function scopedPolicies(value: unknown, allowInherit = false): Record<string, Partial<Record<CapabilityId, OperationPolicy | "inherit">>> {
  if (!isRecord(value)) throw new Error("Scoped tool policies must be an object.");
  const result: Record<string, Partial<Record<CapabilityId, OperationPolicy | "inherit">>> = Object.create(null);
  for (const [id, policies] of Object.entries(value)) {
    if (RESERVED_SCOPE_IDS.includes(id) || !SCOPE_ID.test(id)) throw new Error("Tool policy scope IDs must be 1-128 letters, numbers, dots, underscores, or hyphens.");
    result[id] = capabilityMap(policies, allowInherit);
  }
  return result;
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

function legacyActionsPolicies(value: unknown): Pick<ToolPolicies["global"], "github.actions.dispatch" | "github.actions.cancel" | "github.actions.rerun"> {
  const operations = ["dispatch", "cancel", "rerun"] as const;
  const actions = isRecord(value) ? value : null;
  const invalid = value !== undefined && (
    !actions
    || Object.keys(actions).some((operation) => !operations.includes(operation as (typeof operations)[number]))
    || operations.some((operation) => actions[operation] !== undefined && !["deny", "ask", "allow"].includes(actions[operation] as string))
  );
  const policy = (operation: (typeof operations)[number]): OperationPolicy => {
    if (invalid || actions?.[operation] === "deny") return DENY;
    if (actions?.[operation] === "allow") return ALLOW;
    return ASK;
  };
  return {
    "github.actions.dispatch": policy("dispatch"),
    "github.actions.cancel": policy("cancel"),
    "github.actions.rerun": policy("rerun"),
  };
}

function migrateToolPolicies(raw: Record<string, unknown>): ToolPolicies {
  if (raw.toolPolicies !== undefined) return parseToolPolicies(raw.toolPolicies);
  return {
    version: 1,
    global: {
      ...DEFAULT_TOOL_POLICIES.global,
      "ompweb.agent_tools": raw.agentToolsEnabled === true ? ALLOW : DENY,
      "github.discussions": raw.githubWritesUnasked === true ? ALLOW : ASK,
      ...legacyActionsPolicies(raw.githubActionsPermissions),
    },
    modelRoles: Object.create(null),
    agents: Object.create(null),
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
  };
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

type WebServerSettingsPatch = Partial<Pick<WebServerSettings, "autoResumeSessions" | "agentEnv" | "browserTransport" | "uploadRetentionDays">> & {
  toolPolicies?: ToolPoliciesPatch;
};

function mergeScopedPolicies(current: ToolPolicies["modelRoles"], patch: Record<string, ToolPolicyPatchMap> | undefined): ToolPolicies["modelRoles"] {
  const merged: ToolPolicies["modelRoles"] = Object.create(null);
  for (const [id, policies] of Object.entries(current)) merged[id] = Object.assign(Object.create(null), policies);
  for (const [id, changes] of Object.entries(patch ?? {})) {
    const scope = merged[id] ?? Object.create(null);
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

function capabilitiesRequiringRevocation(current: ToolPolicies, next: ToolPolicies): CapabilityId[] {
  const revoked = new Set<CapabilityId>();
  const changed = (capability: CapabilityId, before: OperationPolicy | undefined, after: OperationPolicy | undefined) => {
    if (before?.enabled === after?.enabled && before?.confirmation === after?.confirmation) return;
    if (after?.enabled === false
      || (before?.enabled === true && after === undefined)
      || (before === undefined && after?.enabled === true && after.confirmation === "ask")
      || (before?.enabled === true && before.confirmation === "allow" && (after?.enabled !== true || after.confirmation !== "allow"))) {
      revoked.add(capability);
    }
  };
  for (const capability of CAPABILITY_IDS) changed(capability, current.global[capability], next.global[capability]);
  for (const kind of ["modelRoles", "agents"] as const) {
    for (const scope of new Set([...Object.keys(current[kind]), ...Object.keys(next[kind])])) {
      for (const capability of CAPABILITY_IDS) {
        changed(capability, current[kind][scope]?.[capability], next[kind][scope]?.[capability]);
      }
    }
  }
  return [...revoked];
}
/** Atomic write (temp file + rename), like the project registry. Private to its user: it holds agentEnv. */
export function saveWebServerSettings(patch: WebServerSettingsPatch): WebServerSettings {
  for (const legacy of ["agentToolsEnabled", "githubWritesUnasked", "githubActionsPermissions"]) {
    if (Object.hasOwn(patch, legacy)) throw new Error(`${legacy} has moved to toolPolicies.`);
  }
  const toolPoliciesPatch = patch.toolPolicies === undefined ? undefined : parseToolPoliciesPatch(patch.toolPolicies);
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
    const settings: WebServerSettings = {
      autoResumeSessions: patch.autoResumeSessions ?? current.autoResumeSessions,
      toolPolicies: mergeToolPolicies(current.toolPolicies, toolPoliciesPatch),
      agentEnv: patch.agentEnv ?? current.agentEnv,
      browserTransport: patch.browserTransport ?? current.browserTransport,
      uploadRetentionDays: patch.uploadRetentionDays === undefined ? current.uploadRetentionDays : patch.uploadRetentionDays,
    };
    // Grants cannot retain caller-scope provenance, so a narrowing scope revokes
    // the capability globally. Revoke first: a failure must leave policy unchanged.
    for (const capability of capabilitiesRequiringRevocation(current.toolPolicies, settings.toolPolicies)) revokeCapability(capability);
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
