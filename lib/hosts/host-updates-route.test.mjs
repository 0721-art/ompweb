import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "ompweb-host-updates-route-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
const hub = await import("./hub.ts");
const { linkHost, linkLocalHost } = await import("./link-driver.test-helper.mjs");
const { HostOpError, MIN_LINK_PROTOCOL_VERSION, LINK_PROTOCOL_VERSION } = await import("./link-protocol.ts");
after(() => {
  hub.flushLinkSamples();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

const info = (protocol = LINK_PROTOCOL_VERSION) => ({
  ompweb: { currentVersion: "0.6.0", availableVersion: "0.7.0", updateAvailable: true, canUpdate: true, blockedReason: null, updateCommand: "npm install -g @kahme247/ompweb@0.7.0", installMethod: "npm", protocolVersion: protocol },
  omp: { currentVersion: "18.0.0", availableVersion: "19.0.0", updateAvailable: true, canUpdate: true, blockedReason: null, updateCommand: "omp update" },
  operation: null,
});
const body = { target: "ompweb", version: "0.7.0" };
const operation = { id: "attempt-1", target: "ompweb", version: "0.7.0", state: "running" };
async function route() {
  assert.equal(typeof hub.getHostSoftwareUpdates, "function", "host update checks are exposed through the host link");
  return import("../../app/api/hosts/[id]/updates/route.ts");
}
const context = (id) => ({ params: Promise.resolve({ id }) });
const post = (r, id, data = body, headers = {}) => r.POST(new Request(`http://main.test/api/hosts/${id}/updates`, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(data),
}), context(id));

const defaultSettings = { ompSource: "upstream", ompRepository: "", ompwebChannel: "stable" };
const customSettings = { ompSource: "custom", ompRepository: "example/omp-fork", ompwebChannel: "prerelease" };
const get = (r, id) => r.GET(new Request(`http://main.test/api/hosts/${id}/updates`), context(id));
const patch = (r, id, settings, headers = {}) => r.PATCH(new Request(`http://main.test/api/hosts/${id}/updates`, {
  method: "PATCH", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(settings),
}), context(id));

function serveUpdateDaemon(link, settings = defaultSettings) {
  const state = { info: { ...info(), settings: { ...settings } }, requests: [] };
  link.serve({
    checkUpdates: (args) => {
      state.requests.push(["checkUpdates", args]);
      return state.info;
    },
    setUpdateSettings: ({ settings }) => {
      state.requests.push(["setUpdateSettings", { settings }]);
      if (state.info.operation?.state === "running") throw new HostOpError(409, "host_updating", "This host is updating");
      state.info.settings = { ...settings };
      return state.info.settings;
    },
    updateSoftware: (args) => {
      state.requests.push(["updateSoftware", args]);
      state.info.operation = { ...operation, target: args.target, version: args.version };
      return { accepted: true, operation: state.info.operation };
    },
  });
  return state;
}

for (const local of [false, true]) test(`software checks and updates target only the ${local ? "local" : "chosen remote"} daemon`, async (t) => {
  const r = await route();
  const link = local ? await linkLocalHost() : await linkHost("Chosen host", { hello: { ompwebVersion: "0.6.0" } });
  t.after(() => {
    link.drop();
    if (local) {
      hub.closeHostLink("local");
      globalThis.__ompHostHub.links.delete("local");
    }
  });
  const seen = [];
  link.serve({
    checkUpdates: (args) => { seen.push(["check", args]); return info(); },
    updateSoftware: (args) => { seen.push(["update", args]); return { accepted: true, operation }; },
  });
  const res = await r.GET(new Request(`http://main.test/api/hosts/${link.id}/updates?force=1`), context(link.id));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ompweb.currentVersion, "0.6.0");
  assert.equal(res.headers.get("cache-control"), "no-store");
  if (!local) assert.equal(hub.hostsSnapshot().hosts.find((host) => host.id === link.id).ompwebVersion, "0.6.0");
  const updated = await post(r, link.id);
  assert.equal(updated.status, 202);
  assert.deepEqual((await updated.json()).operation, operation);
  assert.ok(seen.some(([name, args]) => name === "check" && args.force === true));
  for (const [, args] of seen) assert.deepEqual(args.compatibility, { min: MIN_LINK_PROTOCOL_VERSION, max: LINK_PROTOCOL_VERSION });
});

for (const protocol of [null, LINK_PROTOCOL_VERSION + 1, MIN_LINK_PROTOCOL_VERSION - 1]) test(`an available daemon protocol ${protocol} is visible but cannot be installed even if its host says canUpdate`, async (t) => {
  const r = await route();
  const link = await linkHost("Incompatible host");
  t.after(() => link.drop());
  let installs = 0;
  link.serve({ checkUpdates: () => info(protocol), updateSoftware: (args) => { installs++; return { accepted: true, operation: { ...operation, target: args.target, version: args.version } }; } });
  const checked = await r.GET(new Request(`http://main.test/api/hosts/${link.id}/updates`), context(link.id));
  const result = await checked.json();
  assert.equal(result.ompweb.updateAvailable, true);
  assert.equal(result.ompweb.canUpdate, false);
  assert.ok(result.ompweb.blockedReason);
  assert.equal((await post(r, link.id)).status, 409);
  assert.equal(installs, 0);
  assert.equal((await post(r, link.id, { target: "omp", version: "19.0.0" })).status, 202, "OMP itself does not change the link protocol");
});

test("unknown hosts, offline hosts and old daemons give explicit failures, never run locally", async (t) => {
  const r = await route();
  assert.equal((await r.GET(new Request("http://main.test/api/hosts/missing/updates"), context("missing"))).status, 404);
  const link = await linkHost("Older daemon");
  t.after(() => link.drop());
  link.serve({ checkUpdates: () => { throw new HostOpError(501, "unknown_op", "Unknown host op: checkUpdates"); } });
  assert.equal((await r.GET(new Request(`http://main.test/api/hosts/${link.id}/updates`), context(link.id))).status, 501);
  link.drop();
  assert.equal((await r.GET(new Request(`http://main.test/api/hosts/${link.id}/updates`), context(link.id))).status, 503);
});

test("the browser cannot supply compatibility, commands or an arbitrary target version", async (t) => {
  const r = await route();
  const link = await linkHost("Boundary");
  t.after(() => link.drop());
  let installs = 0;
  link.serve({ checkUpdates: () => info(), updateSoftware: () => { installs++; return { accepted: true, operation }; } });
  for (const bad of [{ ...body, compatibility: { min: 1, max: 99 } }, { target: "shell", version: "1.0.0" }, { ...body, version: "$(touch x)" }, { ...body, command: "reboot" }]) {
    assert.equal((await post(r, link.id, bad)).status, 400);
  }
  assert.equal((await post(r, link.id, { ...body, version: "0.8.0" })).status, 409, "a stale candidate cannot be installed");
  assert.equal((await post(r, link.id, body, { origin: "https://other.test" })).status, 403);
  assert.equal(installs, 0);
});

test("the web server's disabled-update policy blocks host checks and installs before any host operation", async (t) => {
  const r = await route();
  const link = await linkHost("Disabled updates");
  t.after(() => link.drop());
  const previous = process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  process.env.OMP_WEB_DISABLE_AUTOUPDATE = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
    else process.env.OMP_WEB_DISABLE_AUTOUPDATE = previous;
  });
  let checks = 0;
  link.serve({ checkUpdates: () => { checks++; return info(); } });
  assert.equal((await r.GET(new Request(`http://main.test/api/hosts/${link.id}/updates`), context(link.id))).status, 403);
  assert.equal((await post(r, link.id)).status, 403);
  assert.equal(checks, 0);
});

for (const local of [false, true]) test(`update settings roundtrip belongs only to the ${local ? "local" : "chosen remote"} daemon`, async (t) => {
  const r = await route();
  const localLink = await linkLocalHost();
  const remoteLink = await linkHost("Settings host");
  t.after(() => {
    remoteLink.drop();
    localLink.drop();
    hub.closeHostLink("local");
    globalThis.__ompHostHub.links.delete("local");
  });
  const localState = serveUpdateDaemon(localLink);
  const remoteState = serveUpdateDaemon(remoteLink);
  const chosen = local ? localLink : remoteLink;
  const chosenState = local ? localState : remoteState;
  const other = local ? remoteLink : localLink;
  const otherState = local ? remoteState : localState;
  const before = await get(r, chosen.id);
  assert.equal(before.status, 200);
  assert.deepEqual((await before.json()).settings, defaultSettings);

  const saved = await patch(r, chosen.id, customSettings);
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get("cache-control"), "no-store");
  assert.deepEqual(await saved.json(), customSettings);
  assert.deepEqual(chosenState.info.settings, customSettings);
  assert.equal(otherState.requests.length, 0, "saving must not consult or mutate another host");
  const checked = await get(r, chosen.id);
  assert.equal(checked.status, 200);
  assert.deepEqual((await checked.json()).settings, customSettings, "a later check reads daemon storage, not the PATCH response");
  const untouched = await get(r, other.id);
  assert.equal(untouched.status, 200);
  assert.deepEqual((await untouched.json()).settings, defaultSettings);

  const reset = await patch(r, chosen.id, defaultSettings);
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), defaultSettings);
  assert.deepEqual((await (await get(r, chosen.id)).json()).settings, defaultSettings);
});

test("unknown, offline and old settings hosts fail explicitly without falling back to the local daemon", async (t) => {
  const r = await route();
  const local = await linkLocalHost();
  const old = await linkHost("No settings support");
  t.after(() => {
    old.drop();
    local.drop();
    hub.closeHostLink("local");
    globalThis.__ompHostHub.links.delete("local");
  });
  const localState = serveUpdateDaemon(local);
  old.serve({
    checkUpdates: () => info(),
    setUpdateSettings: () => { throw new HostOpError(501, "unknown_op", "Unknown host op: setUpdateSettings"); },
  });
  const unknown = await patch(r, "missing", customSettings);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, "host_not_found");
  const legacyInfo = await get(r, old.id);
  assert.equal(legacyInfo.status, 200);
  assert.equal(Object.hasOwn(await legacyInfo.json(), "settings"), false, "older status does not invent editable defaults");
  const unsupported = await patch(r, old.id, customSettings);
  assert.equal(unsupported.status, 501);
  assert.equal((await unsupported.json()).code, "unknown_op");
  assert.deepEqual(await (await get(r, old.id)).json(), info());
  old.drop();
  const offline = await patch(r, old.id, customSettings);
  assert.equal(offline.status, 503);
  assert.equal((await offline.json()).code, "host_offline");
  assert.equal(localState.requests.length, 0);
  const unchanged = await get(r, local.id);
  assert.equal(unchanged.status, 200);
  assert.deepEqual((await unchanged.json()).settings, defaultSettings);
});

test("invalid settings and cross-origin changes are rejected before daemon dispatch and preserve settings", async (t) => {
  const r = await route();
  const link = await linkHost("Settings boundary");
  t.after(() => link.drop());
  const state = serveUpdateDaemon(link, customSettings);
  const invalid = [
    { ...customSettings, ompRepository: "" },
    { ...customSettings, ompRepository: "   " },
    { ...customSettings, ompRepository: "https://github.com/example/omp-fork" },
    { ...customSettings, ompRepository: "example/../omp-fork" },
    { ...customSettings, ompRepository: "example/omp-fork;reboot" },
    { ...customSettings, ompSource: "other" },
    { ...customSettings, ompwebChannel: "nightly" },
    { ...customSettings, githubToken: "browser_supplied_token" },
    { ...customSettings, command: "reboot" },
    { ompSource: "upstream", ompwebChannel: "stable" },
    null,
    [],
  ];
  for (const settings of invalid) {
    const rejected = await patch(r, link.id, settings);
    assert.equal(rejected.status, 400, JSON.stringify(settings));
    assert.equal((await rejected.json()).code, "invalid_host_update_settings");
  }
  const crossOrigin = await patch(r, link.id, defaultSettings, { origin: "https://other.test" });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).code, "cross_origin_forbidden");
  assert.equal(state.requests.length, 0, "rejected browser input must not reach any daemon operation");
  const unchanged = await get(r, link.id);
  assert.equal(unchanged.status, 200);
  assert.deepEqual((await unchanged.json()).settings, customSettings);
});

test("a running daemon update rejects settings changes and preserves its settings and operation", async (t) => {
  const r = await route();
  const link = await linkHost("Updating settings host");
  t.after(() => link.drop());
  const state = serveUpdateDaemon(link);
  const started = await post(r, link.id);
  assert.equal(started.status, 202);
  assert.deepEqual((await started.json()).operation, operation);
  const rejected = await patch(r, link.id, customSettings);
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, "host_updating");
  const checked = await get(r, link.id);
  assert.equal(checked.status, 200);
  const result = await checked.json();
  assert.deepEqual(result.settings, defaultSettings);
  assert.deepEqual(result.operation, operation);
  assert.deepEqual(state.info.settings, defaultSettings);
});

for (const version of ["0.7.0-rc.1", "20261112T120000Z-0123456789"]) test(`prerelease ${version} is accepted only while it is the available candidate`, async (t) => {
  const r = await route();
  const link = await linkHost("Prerelease candidate");
  t.after(() => link.drop());
  const state = serveUpdateDaemon(link, { ...defaultSettings, ompwebChannel: "prerelease" });
  state.info.ompweb.availableVersion = version;
  const available = await get(r, link.id);
  assert.equal(available.status, 200);
  assert.equal((await available.json()).ompweb.availableVersion, version);
  const staleVersion = version === "0.7.0-rc.1" ? "0.7.0-rc.2" : "20261112T120001Z-0123456789";
  const stale = await post(r, link.id, { target: "ompweb", version: staleVersion });
  assert.equal(stale.status, 409, "valid prerelease syntax must reach the candidate gate");
  assert.equal((await stale.json()).code, "host_update_blocked");
  assert.equal(state.info.operation, null);
  assert.equal(state.requests.filter(([name]) => name === "updateSoftware").length, 0);
  const installed = await post(r, link.id, { target: "ompweb", version });
  assert.equal(installed.status, 202);
  assert.deepEqual((await installed.json()).operation, { ...operation, version });
  const checked = await get(r, link.id);
  assert.equal(checked.status, 200);
  assert.deepEqual((await checked.json()).operation, { ...operation, version });
});

test("the server PAT travels privately to host checks and installs, never browser responses", async (t) => {
  const r = await route();
  const link = await linkHost("Private updates");
  t.after(() => link.drop());
  const previousToken = process.env.GITHUB_TOKEN;
  const token = "github_test_only_private_host_update_token";
  process.env.GITHUB_TOKEN = token;
  t.after(() => {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  });
  const state = serveUpdateDaemon(link);
  const checked = await get(r, link.id);
  assert.equal(checked.status, 200);
  const checkedText = await checked.text();
  assert.equal(checkedText.includes(token), false);
  assert.deepEqual(JSON.parse(checkedText), { ...info(), settings: defaultSettings });
  const installed = await post(r, link.id);
  assert.equal(installed.status, 202);
  const installedText = await installed.text();
  assert.equal(installedText.includes(token), false);
  assert.deepEqual(JSON.parse(installedText), { accepted: true, operation });
  const checks = state.requests.filter(([name]) => name === "checkUpdates");
  const installs = state.requests.filter(([name]) => name === "updateSoftware");
  assert.equal(checks.length, 2, "install rechecks the current candidate");
  assert.equal(installs.length, 1);
  for (const [, args] of [...checks, ...installs]) assert.equal(args.githubToken, token);
  assert.equal(checks[1][1].force, true);
  const visible = await get(r, link.id);
  assert.equal(visible.status, 200);
  const visibleText = await visible.text();
  assert.equal(visibleText.includes(token), false);
  assert.deepEqual(JSON.parse(visibleText), { ...info(), settings: defaultSettings, operation });
});
