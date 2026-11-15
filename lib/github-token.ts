import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir } from "./omp/paths";
import { clearGithubTokenRejection, isGithubTokenRejected } from "./github-fetch";

export interface GithubTokenStatus {
  set: boolean;
  last4: string | null;
  rejected: boolean;
}

export function githubTokenPath(): string {
  return join(getAgentDir(), "omp-web", "github-token.json");
}

export function isValidGithubToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_]{4,255}$/.test(value);
}

/** Saved credentials take precedence; a missing file preserves the environment fallback. */
export function getGithubToken(): string | undefined {
  try {
    const stored: unknown = JSON.parse(readFileSync(githubTokenPath(), "utf8"));
    if (typeof stored === "object" && stored !== null && "token" in stored && isValidGithubToken(stored.token)) return stored.token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read GitHub token");
  }
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
}

export function getGithubTokenStatus(): GithubTokenStatus {
  const token = getGithubToken();
  return { set: Boolean(token), last4: token ? token.slice(-4) : null, rejected: Boolean(token && isGithubTokenRejected(token)) };
}

export function saveGithubToken(token: string): void {
  if (!isValidGithubToken(token)) throw new Error("Invalid GitHub token");
  const path = githubTokenPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ token }), { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  clearGithubTokenRejection(token);
}

export function removeGithubToken(): void {
  try { unlinkSync(githubTokenPath()); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not remove GitHub token");
  }
}
