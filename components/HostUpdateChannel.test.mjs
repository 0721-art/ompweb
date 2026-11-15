import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
const { cleanup, fireEvent, render, within } = await import("@testing-library/react/pure.js");
const { HostUpdateChannel } = await import("./HostUpdateChannel");

test("a failed channel save retains the selection for retry, and accepted settings release the pending state", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { cleanup(); globalThis.fetch = original; });
  let finish;
  const saved = [], pending = [];
  globalThis.fetch = async () => await new Promise((resolve) => { finish = resolve; });
  const { container } = render(createElement(HostUpdateChannel, { endpoint: "/api/hosts/test/updates", settings: { ompwebChannel: "stable" }, disabled: false, onPendingChange: (value) => pending.push(value), onSaved: (value) => saved.push(value) }));
  const page = within(container);
  const select = page.getByLabelText("ompweb channel");
  const save = page.getByRole("button", { name: "Save" });
  assert.equal(save.disabled, true);
  fireEvent.change(select, { target: { value: "Pre-release" } });
  fireEvent.click(save);
  assert.equal(select.disabled, true);
  await act(async () => finish(Response.json({ error: "Host unavailable" }, { status: 503 })));
  assert.match(page.getByRole("alert").textContent, /Host unavailable/);
  assert.equal(select.value, "Pre-release");
  assert.deepEqual(saved, []);
  fireEvent.click(save);
  await act(async () => finish(Response.json({ ompwebChannel: "prerelease" })));
  assert.deepEqual(saved, [{ ompwebChannel: "prerelease" }]);
  assert.deepEqual(pending, [true, false, true, false]);
});

test("a save completing after navigation cannot change the next host's channel", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { cleanup(); globalThis.fetch = original; });
  let finish;
  const saved = [];
  globalThis.fetch = async () => await new Promise((resolve) => { finish = resolve; });
  const { container, unmount } = render(createElement(HostUpdateChannel, { endpoint: "/api/hosts/old/updates", settings: { ompwebChannel: "stable" }, disabled: false, onPendingChange() {}, onSaved: (value) => saved.push(value) }));
  const page = within(container);
  fireEvent.change(page.getByLabelText("ompweb channel"), { target: { value: "Pre-release" } });
  fireEvent.click(page.getByRole("button", { name: "Save" }));
  unmount();
  await act(async () => finish(Response.json({ ompwebChannel: "prerelease" })));
  assert.deepEqual(saved, []);
});
