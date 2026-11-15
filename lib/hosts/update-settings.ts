import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "../omp/paths";

export interface HostUpdateSettings {
  ompwebChannel: "stable" | "prerelease";
}

export const DEFAULT_HOST_UPDATE_SETTINGS: HostUpdateSettings = { ompwebChannel: "stable" };

export function isHostUpdateSettings(value: unknown): value is HostUpdateSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  return Object.keys(settings).length === 1 && (settings.ompwebChannel === "stable" || settings.ompwebChannel === "prerelease");
}

export function readHostUpdateSettings(): HostUpdateSettings {
  try {
    const value: unknown = JSON.parse(readFileSync(join(getAgentDir(), "omp-web", "host-update-settings.json"), "utf8"));
    if (!isHostUpdateSettings(value)) throw new Error("Invalid host update settings");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_HOST_UPDATE_SETTINGS };
    throw error;
  }
}

export function writeHostUpdateSettings(value: unknown): HostUpdateSettings {
  if (!isHostUpdateSettings(value)) throw new Error("Invalid host update settings");
  const root = join(getAgentDir(), "omp-web");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = join(root, "host-update-settings.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  try { renameSync(temporary, target); }
  finally { rmSync(temporary, { force: true }); }
  return value;
}
