import assert from "node:assert/strict";
import test from "node:test";
import { githubFetch, isGithubTokenRejected } from "./github-fetch.ts";

test("GitHub credentials are restricted to HTTPS API requests, including redirects", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: new Headers(init.headers).get("authorization"), cookie: new Headers(init.headers).get("cookie"), redirect: init.redirect });
    return seen.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/asset" } })
      : new Response("asset");
  };
  assert.equal(await (await githubFetch("https://api.github.com/repos/a/b/releases/assets/1", { headers: { Cookie: "private" } }, "private_token_1234")).text(), "asset");
  assert.deepEqual(seen, [
    { url: "https://api.github.com/repos/a/b/releases/assets/1", auth: "Bearer private_token_1234", cookie: "private", redirect: "manual" },
    { url: "https://release-assets.githubusercontent.com/asset", auth: null, cookie: null, redirect: "manual" },
  ]);
  for (const url of ["https://github.com/a/b", "https://api.github.com.evil.example/a", "http://api.github.com/a"]) {
    seen.length = 1;
    await githubFetch(url, { headers: { Authorization: "Bearer supplied", Cookie: "private" } }, "private_token_1234");
    assert.equal(seen.at(-1).auth, null);
    assert.equal(seen.at(-1).cookie, null);
  }
});

test("a rejected token retries once without credentials and marks only that token rejected", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const auth = [];
  let cancelled = false;
  globalThis.fetch = async (_url, init) => {
    auth.push(new Headers(init.headers).get("authorization"));
    if (auth.length === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 401 });
    assert.equal(cancelled, true);
    return new Response("unauthenticated", { status: 401 });
  };
  assert.equal((await githubFetch("https://api.github.com/rate_limit", undefined, "revoked_token_9876")).status, 401);
  assert.deepEqual(auth, ["Bearer revoked_token_9876", null]);
  assert.equal(isGithubTokenRejected("revoked_token_9876"), true);
  assert.equal(isGithubTokenRejected("replacement_token_9876"), false);
});

test("leaving the API strips credentials permanently even when redirected back", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const auth = [];
  globalThis.fetch = async (_url, init) => {
    auth.push(new Headers(init.headers).get("authorization"));
    if (auth.length === 1) return new Response(null, { status: 302, headers: { location: "https://github.com/download" } });
    if (auth.length === 2) return new Response(null, { status: 302, headers: { location: "https://api.github.com/returned" } });
    return new Response("done");
  };
  await githubFetch("https://api.github.com/start", undefined, "redirect_token");
  assert.deepEqual(auth, ["Bearer redirect_token", null, null]);
});
