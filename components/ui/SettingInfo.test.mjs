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

test("uses one labelled button and shows the existing tooltip on hover and focus", async () => {
  const user = userEvent.setup();
  const button = renderInfo();

  assert.equal(document.querySelectorAll("button").length, 1);
  fireEvent.mouseEnter(button);
  assert.equal((await screen.findByRole("tooltip")).textContent, info);
  fireEvent.mouseLeave(button);
  await waitFor(() => assert.equal(screen.queryByRole("tooltip"), null));

  await user.tab();
  assert.equal(document.activeElement, button);
  assert.equal((await screen.findByRole("tooltip")).textContent, info);
});

test("click and touch open an accessible popover", async () => {
  const user = userEvent.setup();
  const button = renderInfo();

  await user.click(button);
  assert.equal(screen.getByRole("dialog", { name: label }).textContent, info);
  await user.keyboard("{Escape}");

  fireEvent.pointerDown(button, { pointerType: "touch" });
  fireEvent.pointerUp(button, { pointerType: "touch" });
  fireEvent.click(button);
  assert.equal(screen.getByRole("dialog", { name: label }).textContent, info);
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
