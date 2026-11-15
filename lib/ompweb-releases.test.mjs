import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { checkPrereleaseUpdate, parsePrereleaseTag, readOmpwebBuild, resolveOmpwebReleaseSha } from "./ompweb-releases.ts";

const sha = "1234567890".repeat(4);
const tag = "20261112T120000Z-1234567890";
const release = (tag_name, published_at, extra = {}) => ({ tag_name, published_at, prerelease: true, draft: false, ...extra });

function fixture(t, releases, { currentSha = "abcdefabcd".repeat(4), builtAt = "2026-11-11T12:00:00Z", resolvedSha = sha, comparison = { status: "ahead" }, comparisonHttpStatus = 200 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ompweb-releases-"));
  const previous = { ...process.env };
  const fetch = globalThis.fetch;
  process.env.OMP_WEB_PACKAGE_DIR = root;
  delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  delete process.env.OMP_WEB_BUILD_SHA;
  delete process.env.OMP_WEB_BUILD_DATE;
  writeFileSync(join(root, "ompweb-build.json"), JSON.stringify({ sha: currentSha, builtAt }));
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/releases?")) return Response.json(releases);
    if (url.includes("/commits/")) return Response.json({ sha: resolvedSha });
    if (url === `https://api.github.com/repos/kahme247/ompweb/compare/${currentSha}...${resolvedSha}`) {
      if (comparison instanceof Error) throw comparison;
      return Response.json(comparison, { status: comparisonHttpStatus });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  t.after(() => { globalThis.fetch = fetch; process.env = previous; rmSync(root, { recursive: true, force: true }); });
  return requests;
}

test("pre-release selection orders by publication rather than API or tag order and resolves the full commit", async (t) => {
  fixture(t, [release("20261112T130000Z-9999999999", "2026-11-12T11:00:00Z"), release(tag, "2026-11-12T12:00:00Z"), release("v9.0.0", "2026-11-13T12:00:00Z", { prerelease: false }), release("20261113T120000Z-8888888888", "2026-11-13T12:00:00Z", { draft: true })]);
  const status = await checkPrereleaseUpdate(true, "private-token");
  assert.equal(status.availableVersion, tag);
  assert.equal(status.releaseTag, tag);
  assert.equal(status.releaseSha, sha);
  assert.equal(status.publishedAt, "2026-11-12T12:00:00Z");
  assert.equal(status.updateAvailable, true);
  assert.ok(!JSON.stringify(status).includes("private-token"));
});

test("a later publication of the running commit is not an update", async (t) => {
  fixture(t, [release(tag, "2026-11-12T12:00:00Z")], { currentSha: sha });
  assert.equal((await checkPrereleaseUpdate(true)).updateAvailable, false);
});

test("a release published before the running build is not offered", async (t) => {
  fixture(t, [release(tag, "2026-11-10T12:00:00Z")]);
  assert.equal((await checkPrereleaseUpdate(true)).updateAvailable, false);
});

for (const comparisonStatus of ["ahead", "identical", "behind", "diverged"]) {
  test(`a newer publication is offered only when its commit is ahead: ${comparisonStatus}`, async (t) => {
    fixture(t, [release(tag, "2026-11-12T12:00:00Z")], { comparison: { status: comparisonStatus } });
    assert.equal((await checkPrereleaseUpdate(true)).updateAvailable, comparisonStatus === "ahead");
  });
}

test("an older commit published out of order remains the newest release but is not offered", async (t) => {
  fixture(t, [
    release("20261112T130000Z-9999999999", "2026-11-12T13:00:00Z"),
    release(tag, "2026-11-12T14:00:00Z"),
  ], { comparison: { status: "behind" } });
  const status = await checkPrereleaseUpdate(true);
  assert.equal(status.availableVersion, tag);
  assert.equal(status.publishedAt, "2026-11-12T14:00:00Z");
  assert.equal(status.releaseSha, sha);
  assert.equal(status.updateAvailable, false);
});

for (const [name, options] of [
  ["missing status", { comparison: {} }],
  ["unknown status", { comparison: { status: "unknown" } }],
  ["null response", { comparison: null }],
  ["HTTP failure", { comparisonHttpStatus: 503 }],
  ["network failure", { comparison: new Error("GitHub unavailable") }],
]) {
  test(`an unknown commit comparison fails closed: ${name}`, async (t) => {
    fixture(t, [release(tag, "2026-11-12T12:00:00Z")], options);
    assert.equal((await checkPrereleaseUpdate(true)).updateAvailable, false);
  });
}

for (const [publishedAt, updateAvailable] of [
  ["2026-11-11T23:59:59Z", false],
  ["2026-11-12T00:00:00Z", true],
]) {
  test(`old binary updates retain the conservative end-of-build-day bound: ${publishedAt}`, async (t) => {
    const currentSha = "abcdefabcd".repeat(4);
    fixture(t, [release(tag, publishedAt)], { currentSha });
    const root = process.env.OMP_WEB_PACKAGE_DIR;
    rmSync(join(root, "ompweb-build.json"));
    mkdirSync(join(root, "dist", "assets"), { recursive: true });
    writeFileSync(join(root, "dist", "assets", "app.js"), `const h="${currentSha}",d="2026-11-11";`);
    assert.equal((await checkPrereleaseUpdate(true)).updateAvailable, updateAvailable);
  });
}

test("malformed stamps, impossible UTC dates and unrelated tags are rejected", () => {
  for (const value of ["v1.2.3", "20260230T120000Z-1234567890", "20261112T250000Z-1234567890", "20261112T120000Z-1234567", "../../1234567890"]) assert.equal(parsePrereleaseTag(value), null, value);
  assert.deepEqual(parsePrereleaseTag(tag), { sha10: "1234567890", timestamp: Date.parse("2026-11-12T12:00:00Z") });
});

test("an unresolved or mismatched tag commit never fabricates a full SHA or offers an update", async (t) => {
  fixture(t, [release(tag, "2026-11-12T12:00:00Z")], { resolvedSha: "f".repeat(40) });
  const status = await checkPrereleaseUpdate(true);
  assert.equal(status.updateAvailable, false);
  assert.equal(status.releaseSha, undefined);
  await assert.rejects(resolveOmpwebReleaseSha(tag), /commit/i);
});

test("old binary builds reuse the logo's full commit without guessing sub-day build time", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ompweb-embedded-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "dist", "assets"), { recursive: true });
  writeFileSync(join(directory, "dist", "assets", "app.js"), `const h="${sha}",d="2026-11-11";`);
  assert.deepEqual(readOmpwebBuild(directory), { sha, builtAt: "2026-11-11T23:59:59.999Z" });
});
