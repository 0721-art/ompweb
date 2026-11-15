import { createHash } from "node:crypto";

// Fingerprints keep late failures for an old token from rejecting its replacement.
const rejected = new Set<string>();
const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex");

export function isGithubTokenRejected(token: string): boolean {
  return rejected.has(fingerprint(token));
}

export function clearGithubTokenRejection(token: string): void {
  rejected.delete(fingerprint(token));
}

export function rejectGithubToken(token: string): void {
  rejected.add(fingerprint(token));
  if (rejected.size > 32) rejected.delete(rejected.values().next().value!);
}

/** Adds a credential only to api.github.com. Redirects never regain it after leaving the API. */
export async function githubFetch(
  input: string | URL,
  init: RequestInit = {},
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
): Promise<Response> {
  let url = new URL(input);
  let options = { ...init };
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  let authenticate = url.protocol === "https:" && url.hostname === "api.github.com" && Boolean(token);
  let retried = false;
  let redirects = 0;

  while (true) {
    if (url.origin !== "https://api.github.com") {
      authenticate = false;
      headers.delete("cookie");
      headers.delete("proxy-authorization");
    }
    headers.delete("authorization");
    if (authenticate) headers.set("authorization", `Bearer ${token}`);
    const response = await fetch(url.toString(), { ...options, headers, redirect: "manual" });
    if (response.status === 401 && authenticate && !retried) {
      rejectGithubToken(token!);
      await response.body?.cancel().catch(() => {});
      authenticate = false;
      retried = true;
      continue;
    }
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location || init.redirect === "manual") return response;
    await response.body?.cancel().catch(() => {});
    if (init.redirect === "error" || redirects++ >= 20) throw new Error("GitHub request redirect refused");
    const next = new URL(location, url);
    if (next.protocol !== "https:" || next.username || next.password) throw new Error("Unsafe GitHub request redirect");
    if (response.status === 303 && options.method?.toUpperCase() !== "HEAD"
      || [301, 302].includes(response.status) && options.method?.toUpperCase() === "POST") {
      options = { ...options, method: "GET", body: undefined };
      headers.delete("content-type");
      headers.delete("content-length");
    }
    url = next;
  }
}
