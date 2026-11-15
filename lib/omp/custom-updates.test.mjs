import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkCustomOmpUpdate, runCustomOmpUpdate, validateCustomOmpRepository } from "./custom-updates.ts";

const repository = "example/oh-my-pi";
const tag = "v18.18.9-int.95bee5c";
const version = "18.18.9-int.95bee5c";
const asset = `omp-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const script = (value, smokeExit = 0) => Buffer.from(`#!/bin/sh\ncase "$1" in\n --version) printf '%s\\n' '${value}' ;;\n --smoke-test) exit ${smokeExit} ;;\n *) exit 10 ;;\nesac\n`);

function setup(t, { linked = false, directCurrent = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "omp-custom-update-"));
  const old = script("omp/18.18.8");
  let bin = join(root, "omp");
  if (linked || directCurrent) {
    mkdirSync(join(root, "releases", "old"), { recursive: true });
    writeFileSync(join(root, "releases", "old", "omp"), old, { mode: 0o755 });
    symlinkSync("releases/old", join(root, "current"));
    if (directCurrent) bin = join(root, "current", "omp");
    else symlinkSync("current/omp", bin);
  } else writeFileSync(bin, old, { mode: 0o755 });
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  const previousDisabled = process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  const previousFetch = globalThis.fetch;
  process.env.OMP_WEB_OMP_BIN = bin;
  delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
    if (previousDisabled === undefined) delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
    else process.env.OMP_WEB_DISABLE_AUTOUPDATE = previousDisabled;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, bin, old };
}

function releaseFetch(binary, { sums = `${digest(binary)}  ${asset}\n`, releaseTag = tag, redirect } = {}) {
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === "api.github.com" && url.pathname.startsWith(`/repos/${repository}/releases/`)) {
      if (![`/repos/${repository}/releases/latest`, `/repos/${repository}/releases/tags/${releaseTag}`].includes(url.pathname)) return new Response(null, { status: 404 });
      return Response.json({ tag_name: releaseTag, assets: [{ name: asset }, { name: "SHA256SUMS.txt" }] });
    }
    if (url.hostname === "github.com" && url.pathname === `/${repository}/releases/download/${releaseTag}/SHA256SUMS.txt`) return new Response(sums);
    if (url.hostname === "github.com" && url.pathname === `/${repository}/releases/download/${releaseTag}/${asset}`) {
      if (redirect) return new Response(null, { status: 302, headers: { location: redirect } });
      return new Response(binary);
    }
    throw new Error(`Unexpected test request: ${url}`);
  };
}

const unixOnly = { skip: process.platform === "win32" };

test("repository validation rejects URLs, traversal, whitespace and malformed owners", () => {
  for (const value of [null, {}, "", "owner", "a/b/c", "../repo", "owner/..", "owner/.", " owner/repo", "owner/repo\n", "https://github.com/a/b", "-owner/repo", "owner-/repo", "a--b/repo", `${"a".repeat(40)}/repo`]) {
    assert.equal(validateCustomOmpRepository(value), false, String(value));
  }
  for (const value of [repository, "a/b", "owner-name/.github", "Org/repo_name.js"]) assert.equal(validateCustomOmpRepository(value), true, value);
});

test("check parses omp version and canonicalizes the available integration tag", unixOnly, async (t) => {
  setup(t);
  releaseFetch(script("omp/18.18.9"));
  const status = await checkCustomOmpUpdate(repository, "");
  assert.equal(status.currentVersion, "18.18.8");
  assert.equal(status.availableVersion, version);
  assert.equal(status.updateAvailable, true);
});

test("check compares integration tags rather than only upstream semver", unixOnly, async (t) => {
  const { bin } = setup(t);
  writeFileSync(bin, script("omp/18.18.9-int.aaaaaaa"), { mode: 0o755 });
  releaseFetch(script("omp/18.18.9"));
  assert.equal((await checkCustomOmpUpdate(repository, "")).updateAvailable, true);
});

test("check rejects a latest release tag containing a path", unixOnly, async (t) => {
  setup(t);
  releaseFetch(script("omp/18.18.9"), { releaseTag: "../../outside" });
  await assert.rejects(checkCustomOmpUpdate(repository, ""), /tag|version/i);
});

test("digest mismatch leaves the executable and current symlink unchanged", unixOnly, async (t) => {
  const { root, bin, old } = setup(t, { linked: true });
  releaseFetch(script("omp/18.18.9"), { sums: `${"0".repeat(64)}  ${asset}\n` });
  await assert.rejects(runCustomOmpUpdate(repository, version, ""), /digest|checksum/i);
  assert.deepEqual(readFileSync(bin), old);
  assert.equal(readlinkSync(join(root, "current")), "releases/old");
  assert.equal(existsSync(join(root, "releases", tag)), false);
});

test("smoke-test failure preserves the old executable and removes only its own release", unixOnly, async (t) => {
  const { root, bin, old } = setup(t, { linked: true });
  releaseFetch(script("omp/18.18.9", 7));
  await assert.rejects(runCustomOmpUpdate(repository, version, ""), /smoke/i);
  assert.deepEqual(readFileSync(bin), old);
  assert.equal(readlinkSync(join(root, "current")), "releases/old");
  assert.equal(existsSync(join(root, "releases", tag)), false);
});

for (const layout of [{ linked: true }, { directCurrent: true }, {}]) {
  test(`successful install records build metadata and replaces ${layout.linked ? "a current symlink through the launcher" : layout.directCurrent ? "an ancestor current symlink" : "a plain executable"}`, unixOnly, async (t) => {
    const { root, bin } = setup(t, layout);
    const binary = script("omp/18.18.9");
    releaseFetch(binary);
    await runCustomOmpUpdate(repository, version, "");
    assert.deepEqual(readFileSync(bin), binary);
    assert.deepEqual(readFileSync(join(root, "releases", tag, "omp")), binary);
    const metadata = JSON.parse(readFileSync(`${realpathSync(bin)}.build.json`, "utf8"));
    assert.equal(metadata.tag, version);
    assert.equal(metadata.buildSha, "95bee5c");
    const status = await checkCustomOmpUpdate(repository, "");
    assert.equal(status.currentVersion, version);
    assert.equal(status.updateAvailable, false);
    if (layout.linked || layout.directCurrent) {
      assert.equal(readlinkSync(join(root, "current")), `releases/${tag}`);
      assert.equal(existsSync(join(root, "releases", "old", "omp")), true);
    }
  });
}

test("stale metadata cannot identify a manually replaced binary as the custom build", unixOnly, async (t) => {
  const { bin } = setup(t);
  releaseFetch(script("omp/18.18.9"));
  await runCustomOmpUpdate(repository, version, "");
  writeFileSync(bin, script("omp/18.18.9\nmanual build"), { mode: 0o755 });
  const status = await checkCustomOmpUpdate(repository, "");
  assert.equal(status.currentVersion, "18.18.9");
  assert.equal(status.updateAvailable, true);
});

test("a pre-existing release is never overwritten or removed", unixOnly, async (t) => {
  const { root, bin, old } = setup(t, { linked: true });
  const existing = join(root, "releases", tag);
  mkdirSync(existing);
  writeFileSync(join(existing, "keep"), "not this operation");
  releaseFetch(script("omp/18.18.9"));
  await assert.rejects(runCustomOmpUpdate(repository, version, ""), /exist|owned/i);
  assert.equal(readFileSync(join(existing, "keep"), "utf8"), "not this operation");
  assert.deepEqual(readFileSync(bin), old);
});

test("concurrent installs cannot both own an attempt or replace the active binary", unixOnly, async (t) => {
  const { bin } = setup(t);
  releaseFetch(script("omp/18.18.9"));
  const results = await Promise.allSettled([runCustomOmpUpdate(repository, version, ""), runCustomOmpUpdate(repository, version, "")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(results.find((result) => result.status === "rejected").reason.message, /progress|lock|exist/i);
  assert.equal((await checkCustomOmpUpdate(repository, "")).currentVersion, version);
  assert.match(readFileSync(bin, "utf8"), /18\.18\.9/);
});

test("unsafe tags and repositories are rejected before filesystem changes", unixOnly, async (t) => {
  const { root, bin, old } = setup(t);
  await assert.rejects(runCustomOmpUpdate(repository, "../../escape", ""), /tag|version/i);
  await assert.rejects(runCustomOmpUpdate("owner/../outside", version, ""), /repository/i);
  assert.equal(existsSync(join(root, "releases")), false);
  assert.deepEqual(readFileSync(bin), old);
});

test("a release download cannot redirect to a non-GitHub host", unixOnly, async (t) => {
  const { bin, old } = setup(t);
  releaseFetch(script("omp/18.18.9"), { redirect: "https://example.org/payload" });
  await assert.rejects(runCustomOmpUpdate(repository, version, ""), /destination|GitHub/i);
  assert.deepEqual(readFileSync(bin), old);
});

test("duplicate checksum entries fail closed instead of selecting an arbitrary digest", unixOnly, async (t) => {
  const { bin, old } = setup(t);
  const binary = script("omp/18.18.9");
  releaseFetch(binary, { sums: `${digest(binary)}  ${asset}\n${"0".repeat(64)}  ${asset}\n` });
  await assert.rejects(runCustomOmpUpdate(repository, version, ""), /checksum|digest/i);
  assert.deepEqual(readFileSync(bin), old);
});

test("a symlinked releases directory cannot redirect installation outside its root", unixOnly, async (t) => {
  const { root, bin, old } = setup(t);
  const outside = mkdtempSync(join(tmpdir(), "omp-custom-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(root, "releases"));
  releaseFetch(script("omp/18.18.9"));
  await assert.rejects(runCustomOmpUpdate(repository, version, ""), /directory|symlink|unsafe/i);
  assert.equal(existsSync(join(outside, tag)), false);
  assert.deepEqual(readFileSync(bin), old);
});

test("unprefixed release tags remain installable and compare as the same version", unixOnly, async (t) => {
  const { bin } = setup(t);
  releaseFetch(script("omp/18.18.9"), { releaseTag: version });
  await runCustomOmpUpdate(repository, version, "");
  assert.equal((await checkCustomOmpUpdate(repository, "")).updateAvailable, false);
  assert.match(readFileSync(bin, "utf8"), /18\.18\.9/);
});

test("oversized responses fail without changing the executable", unixOnly, async (t) => {
  const { bin, old } = setup(t);
  globalThis.fetch = async () => new Response("{}", { headers: { "content-length": String(3 * 1024 * 1024) } });
  await assert.rejects(runCustomOmpUpdate(repository, version, ""), /too large/i);
  assert.deepEqual(readFileSync(bin), old);
});

test("invalid custom tags cannot smuggle a final newline into a release path", unixOnly, async (t) => {
  const { bin, old } = setup(t);
  await assert.rejects(runCustomOmpUpdate(repository, `${version}\n`, ""), /tag|version/i);
  assert.deepEqual(readFileSync(bin), old);
});

test("the update policy also disables custom checks and installations", unixOnly, async (t) => {
  const { bin, old } = setup(t);
  process.env.OMP_WEB_DISABLE_AUTOUPDATE = "1";
  globalThis.fetch = async () => { throw new Error("Disabled updates must not fetch"); };
  assert.equal((await checkCustomOmpUpdate(repository, "")).updatesDisabled, true);
  await assert.rejects(runCustomOmpUpdate(repository, version, ""), /disabled/i);
  assert.deepEqual(readFileSync(bin), old);
});
