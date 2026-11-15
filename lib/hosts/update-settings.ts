import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "../omp/paths";
import { validateCustomOmpRepository } from "../omp/custom-updates";

export interface HostUpdateSettings {
  ompSource: "upstream" | "custom";
  ompRepository: string;
  ompwebChannel: "stable" | "prerelease";
}
export const DEFAULT_HOST_UPDATE_SETTINGS: HostUpdateSettings = { ompSource: "upstream", ompRepository: "", ompwebChannel: "stable" };
export function isHostUpdateSettings(value: unknown): value is HostUpdateSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 3 && (v.ompSource === "upstream" || v.ompSource === "custom")
    && (v.ompwebChannel === "stable" || v.ompwebChannel === "prerelease")
    && typeof v.ompRepository === "string" && (v.ompRepository === "" ? v.ompSource === "upstream" : validateCustomOmpRepository(v.ompRepository));
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
  const temp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temp, target);
  return value;
}
