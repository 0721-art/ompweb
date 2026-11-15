import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitHubReleaseNotes } from "./github-release-notes.ts";
import { saveGithubToken, getGithubTokenStatus } from "./github-token.ts";

test("release notes use the saved token and still load after GitHub rejects it", async (t) => {
  const originalFetch = globalThis.fetch;
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "ompweb-release-notes-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  });
  saveGithubToken("github_pat_release1234");
  const auth = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.github.com/repos/kahme247/ompweb/releases/tags/v2.0.0");
    auth.push(new Headers(init.headers).get("authorization"));
    return auth.length === 1 ? new Response(null, { status: 401 }) : Response.json({ tag_name: "v2.0.0", draft: false, body: "Release notes", html_url: "https://github.com/kahme247/ompweb/releases/tag/v2.0.0" });
  };
  assert.deepEqual(await getGitHubReleaseNotes("2.0.0"), { version: "2.0.0", body: "Release notes", htmlUrl: "https://github.com/kahme247/ompweb/releases/tag/v2.0.0" });
  assert.deepEqual(auth, ["Bearer github_pat_release1234", null]);
  assert.equal(getGithubTokenStatus().rejected, true);
});
