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

test("a rejected token cancels the response and retries exactly once without credentials", async (t) => {
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
  const response = await githubFetch("https://api.github.com/rate_limit", undefined, "revoked_token_9876");
  assert.equal(response.status, 401);
  assert.deepEqual(auth, ["Bearer revoked_token_9876", null]);
  assert.equal(isGithubTokenRejected("revoked_token_9876"), true);
  assert.equal(isGithubTokenRejected("replacement_token_9876"), false);
});

test("manual redirects remain visible and redirect errors never follow a location", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response(null, { status: 302, headers: { location: "https://cdn.example/asset" } }); };
  assert.equal((await githubFetch("https://api.github.com/a", { redirect: "manual" }, "test_token")).status, 302);
  assert.equal(requests, 1);
  await assert.rejects(githubFetch("https://api.github.com/a", { redirect: "error" }, "test_token"), /redirect/i);
  assert.equal(requests, 2);
});

test("redirect loops are bounded and HTTPS requests never downgrade", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: "/loop" } }); };
  await assert.rejects(githubFetch("https://api.github.com/loop", undefined, ""), /redirect/i);
  assert.ok(calls <= 21);
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "http://api.github.com/insecure" } });
  await assert.rejects(githubFetch("https://api.github.com/a", undefined, "test_token"), /redirect/i);
});

test("leaving the API strips credentials permanently even if the redirect returns to the API", async (t) => {
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
