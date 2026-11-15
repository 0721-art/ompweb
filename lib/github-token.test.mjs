import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGithubToken, getGithubTokenStatus, removeGithubToken, saveGithubToken } from "./github-token.ts";

test("saved GitHub tokens are private, atomic, validated and override environment fallback", (t) => {
  const previous = { dir: process.env.PI_CODING_AGENT_DIR, github: process.env.GITHUB_TOKEN, gh: process.env.GH_TOKEN };
  const dir = mkdtempSync(join(tmpdir(), "ompweb-github-token-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.GITHUB_TOKEN = "github_env_fallback";
  process.env.GH_TOKEN = "gh_env_fallback";
  t.after(() => {
    for (const [key, value] of [["PI_CODING_AGENT_DIR", previous.dir], ["GITHUB_TOKEN", previous.github], ["GH_TOKEN", previous.gh]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(getGithubToken(), "github_env_fallback");
  saveGithubToken("github_pat_private1234");
  assert.equal(getGithubToken(), "github_pat_private1234");
  const file = join(dir, "omp-web", "github-token.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).token, "github_pat_private1234");
  assert.deepEqual(readdirSync(join(dir, "omp-web")), ["github-token.json"]);
  assert.deepEqual(getGithubTokenStatus(), { set: true, last4: "1234", rejected: false });
  for (const invalid of ["", "secret\nheader", "has spaces", "x".repeat(256), null, 42]) {
    assert.throws(() => saveGithubToken(invalid), /Invalid GitHub token/);
    assert.equal(getGithubToken(), "github_pat_private1234");
  }
  removeGithubToken();
  assert.equal(getGithubToken(), "github_env_fallback");
  delete process.env.GITHUB_TOKEN;
  assert.equal(getGithubToken(), "gh_env_fallback");
  delete process.env.GH_TOKEN;
  assert.deepEqual(getGithubTokenStatus(), { set: false, last4: null, rejected: false });
});
