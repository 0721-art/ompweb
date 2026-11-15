import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
const { cleanup, fireEvent, render, within } = await import("@testing-library/react/pure.js");
const { HostUpdatePreferences } = await import("./HostUpdatePreferences");
const defaults = { ompSource: "upstream", ompRepository: "", ompwebChannel: "stable" };

test("Custom requires a repository, saves both preferences, and keeps failed edits available for correction", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { cleanup(); globalThis.fetch = original; });
  const pending = [];
  const saved = [];
  let response;
  globalThis.fetch = async () => await new Promise((resolve) => { response = resolve; });
  const props = { endpoint: "/api/hosts/test/updates", settings: defaults, disabled: false, onPendingChange: (value) => pending.push(value), onSaved: (value) => saved.push(value) };
  const { container } = render(createElement(HostUpdatePreferences, props));
  const page = within(container);
  const save = page.getByRole("button", { name: "Save" });
  fireEvent.change(page.getByLabelText("OMP source"), { target: { value: "Custom" } });
  assert.equal(save.disabled, true);
  fireEvent.change(page.getByLabelText("GitHub repository (owner/repo)"), { target: { value: "owner/repo" } });
  fireEvent.change(page.getByLabelText("ompweb channel"), { target: { value: "Pre-release" } });
  fireEvent.click(save);
  assert.equal(page.getByLabelText("GitHub repository (owner/repo)").disabled, true);
  await act(async () => response(Response.json({ error: "Invalid repository" }, { status: 400 })));
  assert.match(page.getByRole("alert").textContent, /Invalid repository/);
  assert.equal(page.getByLabelText("GitHub repository (owner/repo)").value, "owner/repo");
  assert.equal(saved.length, 0);
  fireEvent.click(save);
  await act(async () => response(Response.json({ ompSource: "custom", ompRepository: "owner/repo", ompwebChannel: "prerelease" })));
  assert.deepEqual(saved, [{ ompSource: "custom", ompRepository: "owner/repo", ompwebChannel: "prerelease" }]);
  assert.deepEqual(pending, [true, false, true, false]);
});

test("an unmounted preference save cannot apply to the next host", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { cleanup(); globalThis.fetch = original; });
  let finish;
  const saved = [];
  globalThis.fetch = async () => await new Promise((resolve) => { finish = resolve; });
  const { container, unmount } = render(createElement(HostUpdatePreferences, { endpoint: "/api/hosts/old/updates", settings: defaults, disabled: false, onPendingChange() {}, onSaved: (value) => saved.push(value) }));
  const page = within(container);
  fireEvent.change(page.getByLabelText("ompweb channel"), { target: { value: "Pre-release" } });
  fireEvent.click(page.getByRole("button", { name: "Save" }));
  unmount();
  await act(async () => finish(Response.json({ ...defaults, ompwebChannel: "prerelease" })));
  assert.deepEqual(saved, []);
});
