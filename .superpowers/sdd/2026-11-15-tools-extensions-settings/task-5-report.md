# Task 5 report

## Implemented

- Added shared `SettingInfo` with one accessible Info button.
- The same button exposes detailed content through the existing Tooltip on hover/focus and a Base UI Popover on click/tap.
- Escape and outside interaction close the popover and return focus to its trigger.
- Added optional `info` to `NativeSetting`; rows without it render no information control, and short descriptions remain inline.
- Added optional detailed-information fields to the Settings search index contract. Detailed text participates in matching while result cards continue to render only the short description.
- Kept the label, information button, description, and setting control in the existing compact row structure at 320px.
- Added the English accessible-name template; other locales use the existing English fallback.

## Tests

Red phase:

- `bun test --timeout 30000 components/ui/SettingInfo.test.mjs components/SettingsConfig.setting-info.test.mjs` failed because `SettingInfo`, exported `NativeSetting`, and the detailed search matcher did not exist.

Green/verification:

- `bun test --timeout 30000 components/ui/SettingInfo.test.mjs components/SettingsConfig.setting-info.test.mjs` — 6 pass, 0 fail.
- `bun run typecheck` — passed.
- `bun x eslint components/ui/SettingInfo.tsx components/ui/SettingInfo.test.mjs components/ui/primitives.tsx components/SettingsConfig.tsx components/SettingsConfig.setting-info.test.mjs` — passed.

The DOM tests cover hover, focus, click, touch pointer activation, Escape, outside dismissal, focus return, one-button/tab-stop ownership, accessible names/roles, optional-info omission, detailed search matching, and the compact 320px row structure.

## Scope

No existing setting rows were migrated to detailed information; Tasks 6/7 own those content migrations.
