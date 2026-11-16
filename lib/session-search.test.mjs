import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { compileSearchQuery, scoreSearchFields, searchField, TITLE_WEIGHT, CONTENT_WEIGHT } = await import("./session-search.ts");
const { MAX_CONTENT_CACHE_ENTRIES, searchSessions, transcriptField } = await import("./session-content-search.ts");
const score = (query, title, content = "") =>
  scoreSearchFields([searchField(title, TITLE_WEIGHT), searchField(content, CONTENT_WEIGHT)], compileSearchQuery(query));

test("every word must match, in any order", () => {
  assert.notEqual(score("bug login", "Fix login bug"), null);
  assert.equal(score("login payments", "Fix login bug"), null);
});

test("typed order and exactness rank higher", () => {
  assert.ok(score("login bug", "fix login bug") > score("login bug", "bug in login"));
  assert.ok(score("login", "login page") > score("login", "logins page"));
});

test("typos still match, short words do not get typo tolerance", () => {
  assert.notEqual(score("sidebr", "Sidebar search"), null);
  assert.notEqual(score("kubernetis", "kubernetes cluster"), null);
  assert.equal(score("cat", "car"), null);
  assert.equal(score("node", "code mode"), null);
});

test("a word too far from every word does not match", () => {
  // 5–7 letter terms allow one typo; "too far" must never count as a typo.
  assert.equal(score("xyzzy", "Fix login bug"), null);
  assert.equal(score("rolling", "kubernetes cluster setup", "done"), null);
  assert.equal(score("sidebar", "Totally unrelated words here"), null);
});

test("combining marks stay inside their word, and NFC/NFD forms match each other", () => {
  assert.equal(score("हिन्दी", "ह न द"), null);
  assert.notEqual(score("résumé", "my re\u0301sume\u0301 draft"), null);
});

test("words may split across title and transcript; title matches outrank transcript matches", () => {
  assert.notEqual(score("sidebar ranking", "Sidebar work", "we discussed ranking"), null);
  assert.ok(score("ranking", "Ranking", "") > score("ranking", "Other", "ranking ranking"));
});

test("quoted phrases must appear verbatim", () => {
  assert.notEqual(score('"login bug"', "fix login  bug now"), null);
  assert.equal(score('"bug login"', "fix login bug"), null);
  assert.equal(score('"logn bug"', "fix login bug"), null);
  // Unclosed quote while typing is still a phrase, not loose words.
  assert.equal(score('"bug lo', "fix login bug"), null);
  assert.notEqual(score('"login b', "fix login bug"), null);
  // Typographic quotes from phone keyboards are phrases too.
  assert.equal(score("“bug login”", "fix login bug"), null);
  assert.notEqual(score("“login bug”", "fix login bug"), null);
});

test("empty query compiles to nothing", () => {
  assert.equal(compileSearchQuery('  "" '), null);
});

test("fuzzy scoring handles equal-length typos, prefix typos, and words exceeding initial scratch capacity", () => {
  assert.equal(score("sidebr", "sidebar"), 45);
  assert.equal(score("sidebr", "sidebaring"), 45);
  assert.equal(score("sidebar", "side"), null);
  assert.equal(score("kubernetis", "kubernetes"), 45);
  assert.equal(score("kubernetiz", "kubernetes"), 30);

  const longTerm = "a".repeat(70);
  const oneTypoLongWord = "a".repeat(69) + "b";
  assert.equal(score(longTerm, oneTypoLongWord), 45);
  assert.equal(score(longTerm, longTerm), 100);
});

test("transcriptField extracts active user/assistant text and bounds cache with LRU eviction", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ompweb-search-test-"));
  try {
    const fileA = path.join(tmpDir, "session-a.jsonl");
    const fileB = path.join(tmpDir, "session-b.jsonl");
    const fileC = path.join(tmpDir, "session-c.jsonl");
    await fs.writeFile(
      fileA,
      [
        JSON.stringify({ type: "session", version: 3, id: "00000000-0000-4000-8000-000000000001", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpDir }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "alpha needle" } }),
        JSON.stringify({
          type: "message",
          message: { content: "ignored_tool_output".repeat(50000), details: { id: "nested", parentId: "nested-parent" }, role: "toolResult" },
          id: "t1",
          parentId: "u1",
        }),
        JSON.stringify({ type: "message", id: "abandoned", parentId: "u1", message: { role: "user", content: "abandoned_branch_text" } }),
        JSON.stringify({ type: "message", id: "a1", parentId: "t1", message: { role: "assistant", content: [{ type: "text", text: "beta reply" }] } }),
      ].join("\n") + "\n",
    );
    await fs.writeFile(
      fileB,
      [
        JSON.stringify({ type: "session", version: 1, id: "00000000-0000-4000-8000-000000000002", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpDir }),
        JSON.stringify({ type: "message", message: { role: "user", content: "gamma query" } }),
      ].join("\n") + "\n",
    );
    await fs.writeFile(
      fileC,
      [
        JSON.stringify({ type: "session", id: "00000000-0000-4000-8000-000000000004", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpDir }),
        JSON.stringify({ type: "message", message: { role: "user", content: "versionless legacy query" } }),
      ].join("\n") + "\n",
    );

    const cache = new Map();
    const parseJson = JSON.parse;
    const scheduleImmediate = globalThis.setImmediate;
    let yielded = 0;
    globalThis.setImmediate = (callback, ...args) => {
      yielded++;
      return scheduleImmediate(callback, ...args);
    };
    JSON.parse = (text, reviver) => {
      if (typeof text === "string" && text.includes("ignored_tool_output")) throw new Error("excluded tool payload was parsed");
      return parseJson(text, reviver);
    };
    let fieldA;
    try {
      fieldA = await transcriptField(fileA, cache);
    } finally {
      JSON.parse = parseJson;
      globalThis.setImmediate = scheduleImmediate;
    }
    assert.ok(fieldA);
    assert.equal(fieldA.text.includes("alpha needle"), true);
    assert.ok(yielded > 0, "large excluded records must yield to the event loop");
    assert.equal(fieldA.text.includes("beta reply"), true);
    assert.equal(fieldA.text.includes("ignored_tool_output"), false);
    assert.equal(fieldA.text.includes("abandoned_branch_text"), false);

    for (let i = 0; i < MAX_CONTENT_CACHE_ENTRIES - 1; i++) {
      cache.set(path.join(tmpDir, `filler-${i}.jsonl`), {
        version: `1:${i}`,
        field: Promise.resolve(searchField(`word${i}`, CONTENT_WEIGHT)),
      });
    }
    assert.equal(cache.size, MAX_CONTENT_CACHE_ENTRIES);

    // Touch fileA via a real cache-hit call so filler-0 becomes the oldest entry.
    await transcriptField(fileA, cache);
    // Adding fileB via transcriptField must evict filler-0 while retaining fileA.
    const fieldB = await transcriptField(fileB, cache);
    assert.ok(fieldB);
    assert.equal(fieldB.text.includes("gamma query"), true);
    const fieldC = await transcriptField(fileC, new Map());
    assert.ok(fieldC);
    assert.equal(fieldC.text.includes("versionless legacy query"), true);

    assert.equal(cache.size, MAX_CONTENT_CACHE_ENTRIES);
    assert.equal(cache.has(fileA), true);
    assert.equal(cache.has(fileB), true);
    assert.equal(cache.has(path.join(tmpDir, "filler-0.jsonl")), false);
    assert.equal(cache.has(path.join(tmpDir, "filler-1.jsonl")), true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("searchSessions scores only the active conversation", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ompweb-search-scope-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const sessionId = "00000000-0000-4000-8000-000000000003";
  try {
    process.env.PI_CODING_AGENT_DIR = tmpDir;
    const sessionsDir = path.join(tmpDir, "sessions", "-project");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, `2026-01-01_${sessionId}.jsonl`), [
      JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/project" }),
      JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "precompact_unique_phrase" } }),
      JSON.stringify({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } }),
      JSON.stringify({ type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "kept request" } }),
      JSON.stringify({ type: "compaction", id: "cmp", parentId: "u2", summary: "summary", firstKeptEntryId: "u2", tokensBefore: 10 }),
      JSON.stringify({ type: "message", id: "u3", parentId: "cmp", message: { role: "user", content: "active_unique_phrase" } }),
    ].join("\n") + "\n");
    const { invalidateSessionListCache } = await import("./session-reader.ts");
    invalidateSessionListCache();

    const scores = {};
    for await (const batch of searchSessions("precompact_unique_phrase")) Object.assign(scores, batch);
    assert.equal(scores[sessionId], undefined);
    for await (const batch of searchSessions("active_unique_phrase")) Object.assign(scores, batch);
    assert.equal(typeof scores[sessionId], "number");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    const { invalidateSessionListCache } = await import("./session-reader.ts");
    invalidateSessionListCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// Exercise extraction through its public file boundary, with an independent cache per fixture.
const searchMessage = (id, parentId, content, role = "user") => ({
  type: "message", id, parentId, message: { role, content },
});

async function extractedSearchText(t, records, version = 3) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ompweb-search-boundary-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "session.jsonl");
  await fs.writeFile(file, [
    JSON.stringify({ type: "session", ...(version === null ? {} : { version }) }),
    ...records.map((record) => typeof record === "string" ? record : JSON.stringify(record)),
  ].join("\n") + "\n");
  const field = await transcriptField(file, new Map());
  assert.ok(field, "a readable transcript produces a field");
  return field.text;
}

test("transcript search follows a metadata leaf and excludes an abandoned compaction", async (t) => {
  const text = await extractedSearchText(t, [
    searchMessage("root", null, "shared request"),
    searchMessage("discarded", "root", "abandoned answer", "assistant"),
    { type: "compaction", id: "discarded-cmp", parentId: "discarded", firstKeptEntryId: "discarded", summary: "discarded summary" },
    searchMessage("active", "root", "current answer", "assistant"),
    { type: "model_change", id: "leaf", parentId: "active", modelId: "ignored model" },
  ]);
  assert.equal(text, "shared request current answer");
});

test("only the latest active compaction determines the retained transcript", async (t) => {
  const text = await extractedSearchText(t, [
    searchMessage("old", null, "old request"),
    searchMessage("middle", "old", "middle request"),
    { type: "compaction", id: "cmp1", parentId: "middle", firstKeptEntryId: "middle", summary: "first summary" },
    searchMessage("kept", "cmp1", "retained request"),
    { type: "compaction", id: "cmp2", parentId: "kept", firstKeptEntryId: "kept", summary: "latest summary" },
    searchMessage("reply", "cmp2", "current reply", "assistant"),
  ]);
  assert.equal(text, "retained request current reply");
});

for (const firstKeptEntryId of [undefined, "missing", "abandoned"]) {
  test(`compaction with unavailable retention boundary ${firstKeptEntryId} excludes earlier text`, async (t) => {
    const text = await extractedSearchText(t, [
      searchMessage("old", null, "old request"),
      searchMessage("abandoned", "old", "discarded branch"),
      { type: "compaction", id: "cmp", parentId: "old", firstKeptEntryId, summary: "not searchable" },
      searchMessage("new", "cmp", "current request"),
    ]);
    assert.equal(text, "current request");
  });
}

for (const version of [1, null]) {
  test(`legacy version ${version} uses the compaction entry index including metadata`, async (t) => {
    const text = await extractedSearchText(t, [
      { type: "message", message: { role: "user", content: "old request" } },
      { type: "model_change", modelId: "model" },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "retained reply" }] } },
      { type: "compaction", firstKeptEntryIndex: 3, summary: "ignored summary" },
      { type: "message", message: { role: "user", content: "current request" } },
    ], version);
    assert.equal(text, "retained reply current request");
  });
}

test("malformed lines and nontext blocks do not hide valid active messages", async (t) => {
  const text = await extractedSearchText(t, [
    searchMessage("root", null, "request"),
    "{broken json",
    { type: "message", id: "invalid", message: { role: "user", content: "unlinked text" } },
    searchMessage("reply", "root", [
      { type: "thinking", thinking: "private reasoning" },
      { type: "image", data: "image payload" },
      { type: "text", text: 42 },
      null,
      { type: "text", text: "visible reply" },
    ], "assistant"),
    searchMessage("tool", "reply", "tool output", "toolResult"),
  ]);
  assert.equal(text, "request visible reply");
});

test("large records preserve direct ancestry despite nested keys and escaped delimiters", async (t) => {
  const payload = '\"quoted\" \\ slash } ], '.repeat(6000);
  const text = await extractedSearchText(t, [
    searchMessage("root", null, "request"),
    { details: { id: "decoy", parentId: "wrong", message: { role: "user" }, payload }, type: "custom", id: "metadata", parentId: "root" },
    { type: "message", message: { content: [{ type: "text", text: payload }], role: "toolResult" }, id: "tool", parentId: "metadata" },
    searchMessage("reply", "tool", "visible reply " + "padding ".repeat(9000), "assistant"),
  ]);
  assert.equal(text, ("request visible reply " + "padding ".repeat(9000)).trim());
});
