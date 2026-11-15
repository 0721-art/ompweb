import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET, PUT, POST, DELETE } from "./route.ts";

const request = (method, body, headers = {}) => new Request("http://localhost/api/github-token", { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("token API never returns secrets, bounds input, protects origin and reports rejected fallback", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-github-api-"));
  const old = { dir: process.env.PI_CODING_AGENT_DIR, github: process.env.GITHUB_TOKEN, gh: process.env.GH_TOKEN, fetch: globalThis.fetch };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  t.after(() => {
    globalThis.fetch = old.fetch;
    for (const [key, value] of [["PI_CODING_AGENT_DIR", old.dir], ["GITHUB_TOKEN", old.github], ["GH_TOKEN", old.gh]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const secret = "github_pat_sensitive5678";
  const saved = await PUT(request("PUT", { token: secret }));
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get("cache-control"), "no-store");
  assert.deepEqual(await saved.json(), { set: true, last4: "5678", rejected: false });
  assert.deepEqual(await (await GET(request("GET"))).json(), { set: true, last4: "5678", rejected: false });
  for (const body of [null, [], { token: 42 }, { token: "bad token" }, { token: "x".repeat(256), extra: true }]) {
    assert.equal((await PUT(request("PUT", body))).status, 400);
  }
  assert.equal((await PUT(request("PUT", { token: "x".repeat(5000) }))).status, 413);
  for (const handler of [GET, PUT, POST, DELETE]) {
    const method = handler === GET ? "GET" : handler === PUT ? "PUT" : handler === POST ? "POST" : "DELETE";
    assert.equal((await handler(request(method, method === "PUT" ? { token: secret } : undefined, { origin: "https://evil.example" }))).status, 403);
  }
  const seen = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.github.com/rate_limit");
    seen.push(new Headers(init.headers).get("authorization"));
    return seen.length === 1 ? new Response(null, { status: 401 }) : Response.json({ resources: { core: { limit: 60 } } });
  };
  const tested = await POST(request("POST"));
  assert.equal(tested.status, 200);
  assert.deepEqual(await tested.json(), { set: true, last4: "5678", rejected: true, limit: 60 });
  assert.deepEqual(seen, [`Bearer ${secret}`, null]);
  assert.deepEqual(await (await DELETE(request("DELETE"))).json(), { set: false, last4: null, rejected: false });
});
