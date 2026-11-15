import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readHostUpdateSettings, writeHostUpdateSettings } from "./update-settings.ts";

test("per-host update preferences survive roundtrip and invalid custom settings preserve them", (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-update-settings-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); });
  assert.deepEqual(readHostUpdateSettings(), { ompSource: "upstream", ompRepository: "", ompwebChannel: "stable" });
  const settings = { ompSource: "custom", ompRepository: "andrebrait/oh-my-pi", ompwebChannel: "prerelease" };
  writeHostUpdateSettings(settings);
  assert.deepEqual(readHostUpdateSettings(), settings);
  for (const bad of [{ ...settings, ompRepository: "" }, { ...settings, ompRepository: "https://evil.test/repo" }, { ...settings, ompwebChannel: "nightly" }, { ...settings, command: "oops" }]) assert.throws(() => writeHostUpdateSettings(bad));
  assert.deepEqual(readHostUpdateSettings(), settings);
  if (process.platform !== "win32") assert.equal(statSync(join(root, "omp-web", "host-update-settings.json")).mode & 0o777, 0o600);
});
