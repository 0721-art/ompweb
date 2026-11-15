import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../package.json";
import { githubFetch } from "./github-fetch";
import { detectInstallMethod, type NpmUpdateStatus } from "./npm-update";
import { isUpdateDisabled } from "./update-policy";

const API = "https://api.github.com/repos/kahme247/ompweb";
const TTL = 60 * 60 * 1000;
const FULL_SHA = /^[a-f0-9]{40}$/;
export interface OmpwebBuild { sha: string; builtAt: string }
export interface PrereleaseUpdateStatus extends NpmUpdateStatus {
  releaseTag?: string;
  releaseSha?: string;
  publishedAt?: string;
}
let cached: { checkedAt: number; build: string; status: PrereleaseUpdateStatus } | undefined;

export function parsePrereleaseTag(tag: string): { sha10: string; timestamp: number } | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-([a-f0-9]{10})$/.exec(tag);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== iso.replace("Z", ".000Z")) return null;
  return { sha10: match[7], timestamp };
}

/** Compiled constants describe the loaded build even when its installation has already been replaced. */
export function readOmpwebBuild(directory = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd()): OmpwebBuild | null {
  let value: Partial<OmpwebBuild> = { sha: process.env.OMP_WEB_BUILD_SHA, builtAt: process.env.OMP_WEB_BUILD_DATE };
  if (!value.sha || !value.builtAt) {
    try { value = JSON.parse(readFileSync(join(directory, "ompweb-build.json"), "utf8")); } catch {
      // Older binaries ship the logo's commit/date literals only in their client bundle.
      try {
        for (const file of readdirSync(join(directory, "dist", "assets"))) {
          if (!file.endsWith(".js")) continue;
          const source = readFileSync(join(directory, "dist", "assets", file), "utf8");
          const hashes = [...new Set([...source.matchAll(/["']([a-f0-9]{40})["']/g)].map((match) => match[1]))];
          const days = [...new Set([...source.matchAll(/["'](\d{4}-\d{2}-\d{2})["']/g)].map((match) => match[1]))];
          if (hashes.length === 1 && days.length === 1 && Number.isFinite(Date.parse(days[0]))) return { sha: hashes[0], builtAt: `${days[0]}T23:59:59.999Z` };
        }
      } catch {}
      return null;
    }
  }
  return value && typeof value.sha === "string" && FULL_SHA.test(value.sha) && typeof value.builtAt === "string" && Number.isFinite(Date.parse(value.builtAt)) ? value as OmpwebBuild : null;
}

/** GitHub resolves lightweight and annotated tags; a ten-character tag suffix is never a full commit identity. */
export async function resolveOmpwebReleaseSha(tag: string, token?: string): Promise<string> {
  if (!parsePrereleaseTag(tag) && !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(tag)) throw new Error("Invalid ompweb release tag");
  const response = await githubFetch(`${API}/commits/${encodeURIComponent(tag)}`, { cache: "no-store", signal: AbortSignal.timeout(5000) }, token);
  const data = response.ok ? await response.json() as { sha?: unknown } : null;
  const parsed = parsePrereleaseTag(tag);
  if (typeof data?.sha !== "string" || !FULL_SHA.test(data.sha) || (parsed && !data.sha.startsWith(parsed.sha10))) throw new Error("Release tag commit could not be resolved");
  return data.sha;
}

export async function checkPrereleaseUpdate(force = false, token?: string): Promise<PrereleaseUpdateStatus> {
  const build = readOmpwebBuild();
  const packageDir = process.env.OMP_WEB_PACKAGE_DIR ?? process.cwd();
  const installMethod = typeof Bun !== "undefined" && Bun.isStandaloneExecutable ? "binary" : detectInstallMethod(packageDir);
  const status: PrereleaseUpdateStatus = { currentVersion: packageJson.version, availableVersion: null, updateAvailable: false, installMethod, updateCommand: "https://github.com/kahme247/ompweb/releases" };
  if (isUpdateDisabled()) return { ...status, updatesDisabled: true };
  const identity = `${build?.sha}:${build?.builtAt}:${installMethod}`;
  if (!force && cached?.build === identity && Date.now() - cached.checkedAt < TTL) return cached.status;
  try {
    let newest: { tag_name: string; published_at: string } | undefined;
    // The releases endpoint includes stable releases and drafts, and is not ordered by publication time.
    for (let page = 1; ; page++) {
      const response = await githubFetch(`${API}/releases?per_page=100&page=${page}`, { cache: "no-store", signal: AbortSignal.timeout(5000) }, token);
      if (!response.ok) throw new Error("Release check failed");
      const releases: unknown = await response.json();
      if (!Array.isArray(releases)) throw new Error("Invalid release list");
      for (const release of releases) {
        if (!release || release.draft || release.prerelease !== true || typeof release.tag_name !== "string" || !parsePrereleaseTag(release.tag_name) || typeof release.published_at !== "string" || !Number.isFinite(Date.parse(release.published_at))) continue;
        if (!newest || Date.parse(release.published_at) > Date.parse(newest.published_at)) newest = release;
      }
      if (releases.length < 100) break;
    }
    if (newest) {
      status.availableVersion = newest.tag_name;
      status.releaseTag = newest.tag_name;
      status.publishedAt = newest.published_at;
      status.releaseSha = await resolveOmpwebReleaseSha(newest.tag_name, token);
      if (build && !build.sha.startsWith(parsePrereleaseTag(newest.tag_name)!.sha10) && Date.parse(newest.published_at) > Date.parse(build.builtAt)) {
        const response = await githubFetch(`${API}/compare/${build.sha}...${status.releaseSha}`, { cache: "no-store", signal: AbortSignal.timeout(5000) }, token);
        const comparison = response.ok ? await response.json() as { status?: unknown } | null : null;
        status.updateAvailable = comparison?.status === "ahead";
      }
    }
    cached = { checkedAt: Date.now(), build: identity, status };
    return status;
  } catch {
    return { ...status, releaseSha: undefined, updateAvailable: false };
  }
}
