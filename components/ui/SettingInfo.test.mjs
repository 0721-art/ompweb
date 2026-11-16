import "../../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { SettingInfo } = await import("./SettingInfo.tsx");

afterEach(cleanup);

const label = "More information about Dispatch workflows";
const info = "Only the selected workflow and ref are sent to GitHub.";

function renderInfo() {
  render(createElement(SettingInfo, { label }, info));
  return screen.getByRole("button", { name: label });
}

test("one labelled trigger exposes a stable accessible description on hover and focus", async () => {
  const user = userEvent.setup();
  const button = renderInfo();

  assert.equal(document.querySelectorAll("button").length, 1);
  assert.equal(screen.getByRole("button", { name: label, description: info }), button);

  await user.hover(button);
  assert.equal((await screen.findByRole("tooltip")).textContent, info);
  await user.unhover(button);
  await waitFor(() => assert.equal(screen.queryByRole("tooltip"), null));

  await user.tab();
  assert.equal(document.activeElement, button);
  assert.equal((await screen.findByRole("tooltip")).textContent, info);
});

test("pointer transfer keeps a hover tooltip open and pointer exit does not close a focused tooltip", async () => {
  const user = userEvent.setup();
  const button = renderInfo();

  await user.hover(button);
  const tooltip = await screen.findByRole("tooltip");
  fireEvent.pointerLeave(button, { pointerType: "mouse", relatedTarget: tooltip });
  fireEvent.mouseLeave(button, { relatedTarget: tooltip });
  fireEvent.pointerEnter(tooltip, { pointerType: "mouse", relatedTarget: button });
  fireEvent.mouseEnter(tooltip, { relatedTarget: button });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(screen.getByRole("tooltip"), tooltip);

  fireEvent.blur(button);
  fireEvent.pointerLeave(tooltip, { pointerType: "mouse" });
  fireEvent.mouseLeave(tooltip);
  await waitFor(() => assert.equal(screen.queryByRole("tooltip"), null));

  await user.tab();
  assert.equal(document.activeElement, button);
  await screen.findByRole("tooltip");
  fireEvent.pointerLeave(button, { pointerType: "mouse" });
  fireEvent.mouseLeave(button);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(screen.getByRole("tooltip"), "keyboard focus keeps the tooltip open after pointer exit");
});

test("repeated touch taps toggle the popover through the same trigger", () => {
  const button = renderInfo();
  const tap = () => {
    fireEvent.pointerDown(button, { pointerType: "touch" });
    fireEvent.pointerUp(button, { pointerType: "touch" });
    fireEvent.click(button);
  };

  tap();
  assert.equal(screen.getByRole("dialog", { name: label }).textContent, info);
  tap();
  assert.equal(screen.queryByRole("dialog"), null);
  tap();
  assert.equal(screen.getByRole("dialog", { name: label }).textContent, info);
  assert.deepEqual(screen.getAllByRole("button"), [button]);
});

test("Enter and Space toggle the popover without adding a tab stop", async () => {
  const user = userEvent.setup();
  const button = renderInfo();

  await user.tab();
  assert.equal(document.activeElement, button);
  await user.keyboard("{Enter}");
  assert.ok(screen.getByRole("dialog", { name: label }));
  await user.keyboard("{Escape}");
  assert.equal(document.activeElement, button);
  await user.keyboard(" ");
  assert.ok(screen.getByRole("dialog", { name: label }));
  assert.deepEqual(screen.getAllByRole("button"), [button]);
});

test("Escape and outside interaction close the popover and return focus", async () => {
  const user = userEvent.setup();
  const button = renderInfo();

  await user.click(button);
  await user.keyboard("{Escape}");
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.equal(document.activeElement, button);

  await user.click(button);
  fireEvent.pointerDown(document.body);
  fireEvent.mouseDown(document.body);
  fireEvent.click(document.body);
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.equal(document.activeElement, button);
});
