import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
const { cleanup, render, screen, within } = await import("@testing-library/react/pure.js");
const { NativeSetting, matchSettingSearch } = await import("./SettingsConfig.tsx");

afterEach(cleanup);

const control = () => createElement("button", { type: "button" }, "Change");

test("NativeSetting keeps the short description inline and omits information when absent", () => {
  const { container } = render(createElement(NativeSetting, {
    label: "Ordinary setting",
    description: "A short subtitle.",
    children: control(),
  }));

  assert.ok(screen.getByText("A short subtitle.").classList.contains("settings-card-desc"));
  assert.equal(screen.queryByRole("button", { name: /more information/i }), null);
  assert.equal(container.querySelector(".settings-card").textContent, "Ordinary settingA short subtitle.Change");
});

test("NativeSetting keeps its info button beside the label at 320px instead of below the description", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
  const { container } = render(createElement(NativeSetting, {
    label: "Dispatch workflows",
    description: "Start a selected workflow.",
    info: "Detailed authority and lifecycle information.",
    children: control(),
  }));

  const card = container.querySelector(".settings-card");
  const text = card.querySelector(".settings-card-text");
  const labelRow = text.firstElementChild;
  const infoButton = within(labelRow).getByRole("button", { name: "More information about Dispatch workflows" });

  assert.equal(labelRow.style.display, "flex");
  assert.equal(labelRow.style.flexWrap, "");
  assert.ok(labelRow.contains(infoButton));
  assert.equal(text.querySelector(".settings-card-desc").textContent, "Start a selected workflow.");
  assert.equal(card.textContent.includes("Detailed authority and lifecycle information."), false);
  assert.ok(card.querySelector(":scope > .settings-card-control"));
});

test("detailed information participates in search without replacing the short result description", () => {
  const result = matchSettingSearch({
    id: "dispatch",
    tab: "system",
    fallbackLabel: "Dispatch workflows",
    fallbackDesc: "Start a selected workflow.",
    fallbackSection: "Tool Access",
    fallbackInfo: "Authority follows the requesting agent identity.",
  }, {
    label: "Dispatch workflows",
    description: "Start a selected workflow.",
    section: "Tool Access",
    info: "Authority follows the requesting agent identity.",
  }, "requesting agent");

  assert.equal(result?.id, "dispatch");
  assert.equal(result?.description, "Start a selected workflow.");
  assert.equal("info" in result, false);
});
