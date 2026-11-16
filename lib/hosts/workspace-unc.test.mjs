import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mockBuiltin } from "../../tests/mock-builtin.mjs";

test("UNC directory authorization and Git diff preserve the share rather than the current-drive spelling", async (t) => {
  if (process.platform === "win32") { t.skip("This POSIX filesystem shim models UNC identity; a live UNC share is a separate platform check"); return; }
  // A fresh process binds the filesystem mocks before application modules. Otherwise an
  // already-loaded module calls the OS with the synthetic // path, which macOS treats as a network share and can block past the test deadline.
  if (process.env.OMP_UNC_TEST_CHILD !== "1") {
    const child = spawnSync(process.execPath, ["test", fileURLToPath(import.meta.url), "-t", "UNC directory authorization"], {
      env: { ...process.env, OMP_UNC_TEST_CHILD: "1" },
      timeout: 20_000,
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return;
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-unc-native-")));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); });
  const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-C", root, ...args]);
  git("init", "-q"); git("config", "user.name", "UNC fixture"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "report.txt"), "before\n"); git("add", "report.txt"); git("commit", "-qm", "fixture");
  writeFileSync(join(root, "report.txt"), "share-owned bytes\n");
  const unc = `/${root}`;
  const toNative = (path) => {
    const value = String(path);
    return value === unc || value.startsWith(`${unc}/`) ? root + value.slice(unc.length) : value;
  };
  const fs = { ...await import("node:fs") }, paths = { ...await import("node:path") }, childProcess = { ...await import("node:child_process") };
  const shareIfNeeded = (path, result) => String(path).startsWith(unc) ? `/${result}` : result;
  const nativeFs = {
    ...fs,
    realpathSync: (path, ...args) => shareIfNeeded(path, fs.realpathSync(toNative(path), ...args)),
    lstatSync: (path, ...args) => fs.lstatSync(toNative(path), ...args),
    statSync: (path, ...args) => fs.statSync(toNative(path), ...args),
    readFileSync: (path, ...args) => fs.readFileSync(toNative(path), ...args),
    existsSync: (path) => fs.existsSync(toNative(path)),
    readdirSync: (path, ...args) => fs.readdirSync(toNative(path), ...args),
  };
  nativeFs.realpathSync.native = nativeFs.realpathSync;
  const nativePath = {
    ...paths,
    resolve: (...args) => shareIfNeeded(args.find((arg) => String(arg).startsWith(unc)) ?? "", paths.resolve(...args.map(toNative))),
    join: (...args) => shareIfNeeded(args.find((arg) => String(arg).startsWith(unc)) ?? "", paths.join(...args.map(toNative))),
    relative: (from, to) => paths.relative(toNative(from), toNative(to)),
  };
  const rewriteGitArgs = (args) => Array.isArray(args) ? args.map((arg, index) => args[index - 1] === "-C" ? toNative(arg) : arg) : args;
  const execFile = (file, args, ...rest) => childProcess.execFile(file, rewriteGitArgs(args), ...rest);
  execFile[promisify.custom] = (file, args, options) => promisify(childProcess.execFile)(file, rewriteGitArgs(args), options);
  await mockBuiltin(t, "node:fs", nativeFs);
  await mockBuiltin(t, "fs", nativeFs);
  await mockBuiltin(t, "node:path", nativePath);
  await mockBuiltin(t, "path", nativePath);
  await mockBuiltin(t, "node:child_process", { execFile });
  await mockBuiltin(t, "child_process", { execFile });
  const { grantWorkspaceRoot, authorizeWorkspaceDirectory } = await import("./workspace-roots.ts");
  grantWorkspaceRoot(unc);
  assert.equal(await authorizeWorkspaceDirectory(unc), unc);
  const { createWorkspaceService } = await import("./workspace-ops.ts");
  const { StagedUploads } = await import("./uploads.ts");
  const service = createWorkspaceService(new StagedUploads(() => {}), () => {});
  t.after(() => service.stop());
  const diff = await service.ops.gitDiff(unc, `${unc}/report.txt`);
  assert.equal(diff.ok, true);
  assert.equal(diff.value.supported, true);
  assert.match(diff.value.patch, /\+share-owned bytes/);
});
