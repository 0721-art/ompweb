# Tools & Extensions Settings Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate all tool capability, confirmation and remembered-approval controls under task-first Tools & Extensions navigation.

**Architecture:** A deep tool-policy module resolves global, model-role and per-agent overrides while target-resource gates remain mandatory. A generic persistent approval store records session/resource/capability grants. Settings renders that interface through Tool Access, while MCP, Skills, Plugins and advanced OMP settings remain sibling sections.

**Tech Stack:** TypeScript, React 19, Bun, SQLite, Base UI Tooltip/Popover, existing ompweb settings and OMP runner channel.

**Spec:** `docs/superpowers/specs/2026-11-15-tools-extensions-settings-design.md`

## Global Constraints

- UI copy uses `ompweb`, never `omp-web`.
- Organize by user task, not OMP/ompweb ownership.
- Capability and confirmation are separate fields.
- Explicit per-agent and per-model-role overrides may enable a globally disabled capability; per-agent wins over model role, then global.
- Target-resource denial and external provider authority are mandatory gates and cannot be overridden.
- Remember approvals only for stable resource keys; Bash asks per command unless allowed.
- No new dependency or second update/authentication path.
- Model-role UI cannot ship until authoritative caller role reaches ompweb end to end.
- Version/update relocation must reuse the update implementation that lands from the coordinated-update/version-move work; never duplicate it.
- Existing cluster read-only/live-only behavior remains intact.

## Review Focus

- A role or agent override must never bypass a target host denial or external GitHub refusal.
- Missing/forged caller provenance must resolve to global policy, never a guessed role.
- Changing `allow` to `ask` or disabling a capability must invalidate affected remembered grants before another operation runs.
- Session identity moves, server restarts and session deletion must preserve or remove grants exactly as specified.
- Touch, keyboard and screen-reader users must reach and dismiss detailed information without persistent inline prose.

---

### Task 1: Add authoritative caller provenance to host tools

**Files:**
- Modify upstream OMP host-tool bridge where `host_tool_call` frames are created.
- Modify: `runner/src/host-bridge.ts`
- Modify: `runner/src/commands/tools.ts`
- Modify: `lib/pi-types.ts`
- Modify: `lib/rpc-manager.ts`
- Test: runner host-bridge/channel tests and `lib/rpc-manager.test.mjs`

**Interfaces:**
- Produces optional frame field `caller: { agentId?: string; modelRole?: string }`.
- Callers with no authoritative role omit `modelRole`; ompweb never derives it from provider/model ID.

- [ ] Write failing channel tests proving a main-session call has no invented role and a role-backed agent call carries its authoritative agent/model-role identity.
- [ ] Implement the smallest upstream OMP change that supplies caller provenance when registering/executing host tools.
- [ ] Pass the optional field unchanged through the ompweb runner and validate bounded identifiers in `lib/pi-types.ts`/`rpc-manager.ts`.
- [ ] Verify old frames without `caller` still execute under global policy and forged/invalid fields are ignored or rejected before policy use.
- [ ] Land/update the pinned OMP runner package before exposing model-role controls.

### Task 2: Build the tool-policy module and migrate persisted settings

**Files:**
- Create: `lib/tool-access-policy.ts`
- Test: `lib/tool-access-policy.test.mjs`
- Modify: `lib/web-settings.ts`
- Modify: `lib/web-settings.test.mjs`
- Modify: `app/api/web-settings/route.ts`
- Modify: `lib/api-contract.test.mjs`

**Interfaces:**
- Produces `OperationPolicy`, scoped `inherit` overrides and `resolveToolPolicy(input)`.
- Resolution order for caller capability: agent → model role → global.
- Target-resource policy is returned separately and combined as a mandatory gate by enforcement adapters.

- [ ] Write failing table-driven tests for inheritance, explicit re-enable, per-agent precedence, absent provenance and mandatory target denial.
- [ ] Define capability IDs for OMP/Bash/extensions, ompweb agent tools, browser URL opening and GitHub operation groups.
- [ ] Replace `githubWritesUnasked` and tri-state Actions persistence with the new policy records using a one-time, idempotent migration.
- [ ] Preserve existing effective defaults and reject unknown capability IDs, scope kinds and policy values at the settings route.
- [ ] Ensure unreadable/malformed policy storage fails closed without erasing the source file.

### Task 3: Add persistent remembered approvals

**Files:**
- Create: `lib/tool-approval-store.ts`
- Test: `lib/tool-approval-store.test.mjs`
- Create: `app/api/tool-approvals/route.ts`
- Test: `app/api/tool-approvals/route.test.mjs`
- Modify: `server/routes.ts`
- Modify: `lib/github/watch-store.ts`
- Modify: `lib/github/watch-store.test.mjs`
- Modify session rename/delete lifecycle callers.

**Interfaces:**
- Produces grants keyed by `(sessionId, resourceType, resourceKey, capability)`.
- Supports `has`, `grant`, `list`, `revoke`, `revokeCapability`, `removeSession` and `renameSession`.

- [ ] Write failing tests for independent capability grants, restart persistence, identity moves, deletion, per-grant revoke and clear-all.
- [ ] Implement one SQLite store with parameterized queries, WAL, bounded fields and the project’s finalized-close behavior.
- [ ] Migrate existing GitHub `read_grants` to `github.read_watch`; remove runtime use of the old table after successful migration.
- [ ] Add authenticated list/delete routes for the settings panel; never expose secrets or arbitrary GitHub text.
- [ ] Wire capability disable and `allow → ask` transitions to revoke affected grants transactionally with policy persistence.

### Task 4: Enforce policy and remembered grants at runtime

**Files:**
- Modify: `lib/github/tools.ts`
- Modify: `lib/github/action-tools.ts`
- Modify: `lib/agent-tools.ts`
- Modify: `lib/agent-tool-hosts.ts`
- Modify: `lib/hosts/registry.ts`
- Modify: `lib/rpc-manager.ts`
- Modify: `hooks/useAgentSession-stream.ts`
- Modify: `components/AppShell.tsx`
- Test corresponding GitHub, agent-tool, host-tool and browser-tool suites.

**Interfaces:**
- Consumes `resolveToolPolicy` and the approval store.
- Confirmation messages name capability, resource and session scope.

- [ ] Add failing GitHub tests proving read/watch, discussion writes, dispatch, cancel and rerun grants are independent and remembered per session/repository.
- [ ] Add failing host-start tests proving host denial is mandatory while an agent/model-role override may re-enable the caller capability only.
- [ ] Add failing browser tests for URL-origin grants; cross-origin URLs ask separately and cross-session behavior remains explicit.
- [ ] Add extension-identity grant tests; Bash never writes or consumes a remembered grant.
- [ ] Replace operation-specific confirmation branches with the shared resolver/grant interface while retaining cancellation and unknown-outcome fences.
- [ ] Remove obsolete runtime readers for `githubWritesUnasked`, Actions tri-state settings and bare `allowAgentStart` semantics.

### Task 5: Add compact setting information primitives

**Files:**
- Create: `components/ui/SettingInfo.tsx`
- Test: `components/ui/SettingInfo.test.mjs`
- Modify: `components/SettingsConfig.tsx` (`NativeSetting`)
- Test: focused SettingsConfig accessibility tests.

**Interfaces:**
- `NativeSetting` keeps short `description` and gains optional `info`.
- `SettingInfo` uses existing Tooltip and Base UI Popover with one labelled button.

- [ ] Write failing DOM tests for hover/focus tooltip, click/tap popover, Escape/outside close and focus return.
- [ ] Implement the info button with existing tokens, `Info` icon and no new dependency.
- [ ] Keep short descriptions inline; render no info button when detailed content is absent.
- [ ] Add detailed info to Settings search indexing without showing it as inline prose.
- [ ] Verify 320 px and desktop layouts do not wrap the control beneath a paragraph by default.

### Task 6: Build task-first Tools & Extensions navigation

**Files:**
- Create: `components/ToolsExtensionsConfig.tsx`
- Test: `components/ToolsExtensionsConfig.test.mjs`
- Modify: `components/SettingsTabs.tsx`
- Modify: `components/SettingsConfig.tsx`
- Modify: `components/AgentsConfig.tsx`
- Modify: `components/HostsConfig.tsx`
- Modify: locale files under `lib/i18n/locales/`.

**Interfaces:**
- Internal sections: Tool Access, MCP Servers, Skills, Plugins, OMP System.
- Uses the AI Models segmented-navigation behavior, not its source-oriented labels.

- [ ] Write failing component tests that find every editable tool capability/confirmation control only under Tool Access.
- [ ] Move OMP approvals, Bash, extension requests, ompweb Agent tools, URL opening, GitHub policies, per-agent allowlists and per-host agent-start policy into Tool Access.
- [ ] Replace editable copies in Agents and Hosts with summaries and **Manage tool access** navigation.
- [ ] Keep MCP, Skills and Plugins management intact under their dedicated sections.
- [ ] Remove Safety & Approvals after its last control moves; update search entries and deep-link normalization.
- [ ] Add OMP System navigation only with supported advanced settings; do not add an empty panel or invent unsupported LSP schema. LSP exposure is a follow-up once its official config contract is sourced.

### Task 7: Add scoped policy and remembered-approval management UI

**Files:**
- Modify: `components/ToolsExtensionsConfig.tsx`
- Test: `components/ToolsExtensionsConfig.test.mjs`
- Modify model-role and agent data routes only as needed for inventory.

**Interfaces:**
- Global policy rows expose Enabled plus Ask/Allow.
- Model-role and agent overrides expose Inherit/Disabled/Ask/Allow.
- Remembered approvals list session, resource and capability with revoke actions.

- [ ] Write failing tests for global defaults, model-role overrides, per-agent precedence and target-host denial messaging.
- [ ] Render external availability separately from configured policy; a provider refusal never mutates policy.
- [ ] Render remembered approvals with per-grant revoke and clear-all confirmation.
- [ ] Reconcile successful partial saves from the server response so sibling policies cannot remain stale.
- [ ] Disable role controls until authoritative caller-provenance support is present in the bundled runner.

### Task 8: Integrate ompweb versions and updates into Hosts

**Files:**
- Reuse files landed by `ompweb-dev/ompweb#495` or the owner’s replacement version-move PR.
- Modify: `components/HostsConfig.tsx`
- Modify: `components/HostUpdates.tsx`
- Modify: `components/SettingsConfig.tsx`
- Modify: `components/AppShell.tsx` only to move existing props/state, not duplicate them.
- Test: Hosts/System update ownership tests.

**Interfaces:**
- Hosts renders central **Web server** update entry before daemon host entries.
- System renders no ompweb version, update notice, check or update action.

- [ ] Before editing, rebase onto current main and identify the landed coordinated-update/version-move implementation.
- [ ] Write failing tests proving all ompweb version/update surfaces are under Hosts and absent from System.
- [ ] Move/reuse the existing central update state/actions; keep one update path and one dialog.
- [ ] Preserve host daemon and bundled OMP update behavior, operation progress and rollback information.
- [ ] Update System title/subtitle to runtime and service administration only.

### Task 9: End-to-end verification and documentation

**Files:**
- Modify: `README.md` only if user-facing settings documentation exists there.
- Update the approved design if implementation constraints changed.

- [ ] Run focused policy, approval-store, GitHub, agent-tool, host, Settings and route tests with Bun parallel isolation.
- [ ] Run typecheck and scoped lint.
- [ ] Build the client and verify Tool Access in a real browser at 320, 768 and desktop widths.
- [ ] Verify keyboard navigation, screen-reader names, hover/focus/tap information behavior, successful-save reconciliation and remembered-grant revocation.
- [ ] Run one condensed adversarial review covering contract, hostile inputs, test honesty and over-engineering; fix findings and rerun affected checks.
- [ ] Publish as reviewable increments; do not combine the upstream caller-provenance change, policy backend and large UI move into one unreviewable commit.
