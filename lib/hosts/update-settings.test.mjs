import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readHostUpdateSettings, writeHostUpdateSettings } from "./update-settings.ts";

test("the host update channel defaults to stable and survives a strict round trip", (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-update-settings-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });

  assert.deepEqual(readHostUpdateSettings(), { ompwebChannel: "stable" });
  writeHostUpdateSettings({ ompwebChannel: "prerelease" });
  assert.deepEqual(readHostUpdateSettings(), { ompwebChannel: "prerelease" });
  for (const bad of [{}, { ompwebChannel: "nightly" }, { ompwebChannel: "stable", extra: true }]) assert.throws(() => writeHostUpdateSettings(bad));
  assert.deepEqual(readHostUpdateSettings(), { ompwebChannel: "prerelease" });
  if (process.platform !== "win32") assert.equal(statSync(join(root, "omp-web", "host-update-settings.json")).mode & 0o777, 0o600);
});
