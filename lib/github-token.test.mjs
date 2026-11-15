import assert from "node:assert/strict";
import test from "node:test";
import { linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGithubToken, getGithubTokenStatus, saveGithubToken, removeGithubToken } from "./github-token.ts";

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

test("generic file access refuses the saved PAT, temporary files and aliases but admits independent artifacts", async (t) => {
  const { isOmpSecretFile } = await import("./file-access.ts");
  const { authorizeFileAccess } = await import("./file-authorization.ts");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), "ompweb-pat-file-gate-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); });
  saveGithubToken("github_pat_private1234");
  const secret = join(root, "agent", "omp-web", "github-token.json");
  const hard = join(root, "innocent.txt");
  linkSync(secret, hard);
  const temporary = `${secret}.pending.tmp`;
  writeFileSync(temporary, "private");
  const protectedPaths = [secret, hard, temporary];
  if (process.platform !== "win32") {
    const symbolic = join(root, "alias.txt");
    symlinkSync(secret, symbolic);
    protectedPaths.push(symbolic);
  }
  for (const file of protectedPaths) {
    assert.equal(isOmpSecretFile(file), true, file);
    const result = await authorizeFileAccess([file], null, false, new Set([root]));
    assert.equal(result.ok, false, file);
    assert.equal(result.code, "access_denied");
  }
  mkdirSync(join(root, "workspace"));
  const independent = join(root, "workspace", "github-token.json");
  writeFileSync(independent, "public fixture");
  assert.equal(isOmpSecretFile(independent), false);
  assert.equal((await authorizeFileAccess([independent], null, false, new Set([root]))).ok, true);
});
