import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react/pure.js");
const { SettingsConfig } = await import("./SettingsConfig");

const noop = () => {};
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
const settingsProps = {
  activeTab: "system",
  toolCallsDefaultCollapsed: false, onToolCallsDefaultCollapsedChange: noop,
  hideToolActivity: false, onHideToolActivityChange: noop,
  expandThinkingByDefault: false, onExpandThinkingByDefaultChange: noop, onHideThinkingBlockChange: noop,
  providerUsageVisible: false, onProviderUsageVisibleChange: noop,
  scopeNativeSelectAll: false, onScopeNativeSelectAllChange: noop,
  openUrlAutomatically: false, onOpenUrlAutomaticallyChange: noop,
  cwd: null, remoteHost: false, sessionId: null,
  onModelsSaved: noop, onPluginsReloaded: noop,
  appUpdate: null, onRefreshAppUpdate: async () => null,
  onRequestAppUpdate: noop, onSelectTab: noop, onClose: noop,
};

async function choose(select, name) {
  fireEvent.click(select);
  const list = await waitFor(() => within(document.body).getByRole("listbox"));
  const option = within(list).getByRole("option", { name, exact: true });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option);
  await settle();
}

const policies = (dispatch, cancel, rerun, agentTools = false, discussions = "ask") => ({ toolPolicies: { global: {
  "ompweb.agent_tools": { enabled: agentTools, confirmation: agentTools ? "allow" : "ask" },
  "github.discussions": { enabled: true, confirmation: discussions },
  "github.actions.dispatch": { enabled: dispatch !== "deny", confirmation: dispatch === "allow" ? "allow" : "ask" },
  "github.actions.cancel": { enabled: cancel !== "deny", confirmation: cancel === "allow" ? "allow" : "ask" },
  "github.actions.rerun": { enabled: rerun !== "deny", confirmation: rerun === "allow" ? "allow" : "ask" },
} } });

function installFetch(t, get) {
  const puts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "/api/web-settings") return Response.json({});
    if (init?.method === "PUT") {
      const pending = Promise.withResolvers();
      puts.push({ body: init.body, ...pending });
      return pending.promise;
    }
    return get();
  };
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });
  return puts;
}

test("GitHub Actions permission controls stay disabled until their settings load", async (t) => {
  const pending = Promise.withResolvers();
  installFetch(t, () => pending.promise.then(() => Response.json(policies("ask", "ask", "ask"))));
  const { container } = render(createElement(SettingsConfig, settingsProps));
  const page = within(container);
  const selects = [
    page.getByRole("combobox", { name: "Dispatch workflows" }),
    page.getByRole("combobox", { name: "Cancel workflow runs" }),
    page.getByRole("combobox", { name: "Rerun workflow runs" }),
  ];
  assert.ok(selects.every((select) => select.disabled));
  pending.resolve();
  await settle();
  assert.ok(selects.every((select) => !select.disabled));
});

test("GitHub Actions permissions load as three selects and save only the changed operation", async (t) => {
  const puts = installFetch(t, () => Response.json(policies("ask", "deny", "allow")));
  const { container } = render(createElement(SettingsConfig, settingsProps));
  await settle();
  const page = within(container);
  const dispatch = page.getByRole("combobox", { name: "Dispatch workflows" });
  assert.equal(dispatch.textContent, "Ask each time");
  assert.equal(page.getByRole("combobox", { name: "Cancel workflow runs" }).textContent, "Blocked");
  assert.equal(page.getByRole("combobox", { name: "Rerun workflow runs" }).textContent, "Allow without asking");

  await choose(dispatch, "Allow without asking");
  assert.deepEqual(puts.map(({ body }) => body), ['{"toolPolicies":{"global":{"github.actions.dispatch":{"enabled":true,"confirmation":"allow"}}}}']);
  assert.equal(dispatch.disabled, true, "the control stays disabled while its save is in flight");
  puts[0].resolve(Response.json(policies("allow", "allow", "deny", true, "allow")));
  await settle();
  assert.equal(dispatch.disabled, false);
  assert.equal(dispatch.textContent, "Allow without asking");
  assert.equal(page.getByRole("combobox", { name: "Cancel workflow runs" }).textContent, "Allow without asking");
  assert.equal(page.getByRole("combobox", { name: "Rerun workflow runs" }).textContent, "Blocked");
  assert.equal(page.getByRole("switch", { name: "Agent tools (cross-session)" }).getAttribute("aria-checked"), "true");
  assert.equal(page.getByRole("switch", { name: "Allow agent GitHub writes without asking" }).getAttribute("aria-checked"), "true");
});

test("an uncertain GitHub Actions save re-fetches disk state and never presents the unsaved choice as successful", async (t) => {
  let persisted = policies("ask", "ask", "ask");
  let loads = 0;
  const puts = installFetch(t, () => {
    loads++;
    return Response.json(persisted);
  });
  const { container } = render(createElement(SettingsConfig, settingsProps));
  await settle();
  const dispatch = within(container).getByRole("combobox", { name: "Dispatch workflows" });

  await choose(dispatch, "Allow without asking");
  const previousLoads = loads;
  puts[0].reject(new TypeError("Failed to fetch"));
  await settle();
  assert.ok(loads > previousLoads);
  assert.equal(dispatch.textContent, "Ask each time");

  persisted = null;
  await choose(dispatch, "Blocked");
  puts[1].reject(new TypeError("Failed to fetch"));
  await settle();
  assert.equal(dispatch.disabled, true, "a failed reconciliation leaves the permission unknown");
});

test("late initial GETs cannot overwrite a newer successful PUT response", async (t) => {
  const pendingAgent = Promise.withResolvers();
  const pendingDiscussions = Promise.withResolvers();
  let gets = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "/api/web-settings") return Response.json({});
    if (init?.method === "PUT") return Response.json(policies("allow", "allow", "allow", true, "allow"));
    gets++;
    if (gets === 1) return pendingAgent.promise;
    if (gets === 2) return pendingDiscussions.promise;
    return Response.json(policies("ask", "ask", "ask"));
  };
  t.after(() => { cleanup(); globalThis.fetch = originalFetch; });

  const { container } = render(createElement(SettingsConfig, settingsProps));
  await settle();
  const page = within(container);
  await choose(page.getByRole("combobox", { name: "Dispatch workflows" }), "Allow without asking");
  pendingAgent.resolve(Response.json(policies("ask", "ask", "ask", false, "ask")));
  pendingDiscussions.resolve(Response.json(policies("ask", "ask", "ask", false, "ask")));
  await settle();

  assert.equal(page.getByRole("switch", { name: "Agent tools (cross-session)" }).getAttribute("aria-checked"), "true");
  assert.equal(page.getByRole("switch", { name: "Allow agent GitHub writes without asking" }).getAttribute("aria-checked"), "true");
  assert.equal(page.getByRole("combobox", { name: "Dispatch workflows" }).textContent, "Allow without asking");
});
