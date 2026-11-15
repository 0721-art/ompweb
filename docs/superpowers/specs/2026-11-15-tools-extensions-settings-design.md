# Tools & Extensions Settings Consolidation

Status: approved in conversation, 2026-11-15.

## Intent

Make Settings reflect user tasks rather than implementation ownership. Every tool capability, enablement control, confirmation policy and remembered approval has one home under **Tools & Extensions**. Users should not need to know whether OMP or ompweb implements a feature to configure it.

The design also removes ompweb version/update surfaces from System and places them in Hosts. An overlapping update-coordination change may land first; implementation must build on that result rather than duplicate it.

## Goals

- One panel owns tool availability, confirmation policy and remembered approvals.
- Separate capability from confirmation: whether an operation may happen is independent from whether it asks first.
- Organize settings by user intent; implementation source is secondary metadata.
- Keep prominent integrations—MCP, Skills and Plugins—easy to reach.
- Provide an **OMP System** section for advanced native settings without making OMP ownership the global navigation model.
- Replace long inline explanations with compact subtitles and accessible information popovers.
- Move central ompweb version/update UI from System to Hosts without duplicating update state or actions.

## Non-goals

- Reimplementing OMP's TUI or exposing every native setting in this change.
- Moving presentation-only tool-call display preferences out of Interface & Behavior.
- Moving credential sharing out of Hosts.
- Removing the composer’s contextual current-session tool preset.
- Changing GitHub authentication; GitHub tools continue to use the server’s `gh` login.
- Adding workflow enable/disable, deployment approval or arbitrary GitHub API access.

## Product-first navigation

Use the segmented-navigation pattern already used by AI Models. The top-level **Tools & Extensions** tab contains these sections:

1. **Tool Access**
2. **MCP Servers**
3. **Skills**
4. **Plugins**
5. **OMP System**

This is intentionally not split into “OMP tools” and “ompweb tools.” Source ownership may appear as a small scope chip or inside the information popover, never as the primary organization.

### Tool Access

This section owns all runtime tool capability and confirmation controls:

- Default tool preset; the composer retains its current-session override.
- OMP approval defaults, Bash access and extension-request access.
- ompweb Agent tools master gate.
- Browser actions such as automatic `open_url` handling.
- GitHub read/watch, discussion/review writes, workflow dispatch, cancellation and rerun.
- Per-agent tool allowlists and per-model-role policy overrides.
- Per-host agent-start access.
- Remembered approval inventory and revocation.

Agents and Hosts may show read-only summaries and a **Manage tool access** link. They must not retain editable duplicates. Agents continues to own model, reasoning, spawn and prompt configuration. Hosts continues to own host identity, cluster membership and credential sharing.

### MCP Servers

Keep MCP prominent and self-contained:

- Server inventory and status.
- Add/edit/remove.
- Per-server enablement.
- Project MCP discovery.
- Result rendering and resource-update behavior.

### Skills

Keep skill discovery, installation, updates and model-visibility controls together.

### Plugins

Keep plugin installation, scope, updates and package enablement together.

### OMP System

This is an advanced escape hatch for native settings that lack a stronger product-level home. Initial candidates include LSP server configuration and other TUI-exposed runtime integrations added in later changes. It is not the default destination for every OMP-owned setting.

## Capability and confirmation model

Do not encode `deny / ask / allow` as one field. The interface is two-dimensional:

```ts
interface OperationPolicy {
  enabled: boolean;
  confirmation: "ask" | "allow";
}
```

- `enabled: false` blocks the operation at that policy scope.
- `enabled: true, confirmation: "ask"` requires a remembered grant where the operation has a stable resource identity.
- `enabled: true, confirmation: "allow"` runs without a confirmation.

The global policy is a default, not a ceiling. An explicit scoped override may enable a capability whose global default is disabled. Supported scopes are:

1. Per-agent definition.
2. Per-model role, using the same roles configured in AI Models (for example advisor, designer and task).
3. Global default.

For model-executed capabilities, per-agent overrides win over model-role overrides, which win over the global default. Each scoped field also supports `inherit`, so changing a global default still reaches scopes without an explicit choice.

Model-role enforcement requires authoritative caller provenance. The current host-tool frame carries the tool name and arguments but no agent/model role. Implementation must first add caller agent/model-role identity to OMP’s host-tool bridge and the ompweb runner channel, then validate and consume it in ompweb. Do not expose model-role overrides in the UI until that end-to-end identity is available; inferring a role from the resolved model ID is incorrect because several roles may select the same model.

Target-resource policy is an independent mandatory gate, not another override. A target host that refuses agent starts cannot be bypassed by an agent or model-role override. External provider authority is likewise mandatory.

External availability is a third, read-only status. For example, ompweb may permit GitHub dispatch while GitHub refuses it because `gh` lacks repository authority. The UI reports that refusal evidence; it never silently changes local policy or credentials.

The model applies to capability groups, not only integrations. Initial GitHub groups are:

- Read and watch.
- Comment and manage review threads.
- Dispatch workflows.
- Cancel workflow runs.
- Rerun workflows or jobs.

A grant for one group never authorizes another.

## Remembered approvals

“Ask” means ask once per session, resource and capability group, then remember the decision for that session’s lifetime only when the operation has a stable, bounded resource identity.

Initial remembered resource keys are:

- GitHub: `OWNER/REPO`.
- Host-start access: host ID.
- Browser URL opening: URL origin.
- Extension requests: extension identity.

Bash never receives a remembered grant: it asks for each command unless its resolved policy is `allow`.

Confirmation text explicitly names the capability, resource and session scope.

Grant identity is:

```text
(session_id, resource_type, resource_key, capability)
```

Requirements:

- Grants survive ompweb restarts and legal session identity moves.
- Session deletion removes its grants.
- Disabling a capability removes its grants.
- Changing confirmation from `allow` to `ask` removes existing grants so the next operation asks.
- Per-grant revoke and **Clear all remembered approvals** live in Tool Access.
- A session/repository read grant does not grant comments, dispatch, cancellation or rerun.
- Existing repository read grants migrate to the GitHub read/watch capability.
- Target-host denials remain mandatory even when a model-role or agent override enables the caller capability.

## Existing-state migration

Preserve effective behavior while converting storage:

- Actions `deny` → `{ enabled: false, confirmation: "ask" }`.
- Actions `ask` → `{ enabled: true, confirmation: "ask" }`.
- Actions `allow` → `{ enabled: true, confirmation: "allow" }`.
- `githubWritesUnasked: false` → comment/review enabled + ask.
- `githubWritesUnasked: true` → comment/review enabled + allow.
- Existing GitHub read-grant rows become GitHub read/watch grants.
- The Agent tools master gate migrates to the global default for ompweb-tool capabilities; explicit model-role and agent overrides may narrow or enable individual capabilities.

Migration is clean-cut: once converted, runtime enforcement reads the new policy model only. No compatibility aliases remain.

## Information disclosure and refusal states

Rows distinguish:

1. **Configured policy** — local enabled/confirmation choices.
2. **Remembered approval** — session-scoped grant state.
3. **External availability** — observed provider/tool status.

A GitHub 403 is not automatically a missing scope. Show only evidence GitHub supplies: accepted permissions/scopes, SSO requirements, rate limits and safe response reasons.

## Compact setting rows

Extend the shared setting-row interface:

```tsx
<NativeSetting
  label="Dispatch workflows"
  description="Start a selected GitHub Actions workflow."
  info="Long authority, lifecycle and failure explanation."
/>
```

- `description` remains a short, single-purpose subtitle.
- `info` is optional detailed content.
- Rows with `info` render a labelled information button beside the label.
- Hover/focus exposes the information through the existing Tooltip primitive.
- Click/tap opens an accessible Popover using the existing Base UI pattern.
- Escape and outside interaction close the popover; focus returns to the button.
- Long information remains indexed by Settings search.
- Do not add a new paragraph card beneath the row.

Use detailed information for destructive behavior, authority scope, credential boundaries, remembered-grant semantics and unusual lifecycle behavior. Ordinary rows keep only the subtitle.

## Tab removals and retained settings

Remove **Safety & Approvals** after moving its controls into Tool Access.

Keep presentation-only settings in Interface & Behavior:

- Tool-call collapse/expansion.
- Process-details folding.
- Thinking display.

Keep contextual controls where actions occur:

- Composer current-session tool preset.
- Agent and Host read-only access summaries with links to Tool Access.

System retains runtime/service administration only:

- Session auto-resume.
- Upload retention.
- Agent environment.
- Windows service/tray controls.

## Hosts and ompweb updates

Hosts owns every visible ompweb version/update surface:

- Central web server.
- This machine’s host daemon.
- Linked host daemons.
- Bundled OMP version where relevant.

Place a **Web server** entry before host rows and reuse the existing app-update state and actions. Remove version strings, update notices, checks and update actions from System.

This work overlaps coordinated update PRs, notably `ompweb-dev/ompweb#495`. Before implementation, inspect current `main` and the owner’s version-move PR. Reuse the landed update module and UI; never create a second update path.

## Approaches considered

### Source-first OMP/ompweb split

Rejected. It mirrors implementation boundaries but forces users to understand architecture before finding a setting.

### One flat Tools list

Rejected. It centralizes controls but becomes unscannable as MCP, skills, plugins, agents and native settings grow.

### Task-first sections with OMP System escape hatch

Chosen. It keeps common workflows prominent, preserves access to native internals, and allows implementation ownership to remain secondary metadata.

## Constraints

- No new dependencies.
- Use existing design tokens, Tooltip, Popover, ThemedSelect and setting-row conventions.
- Mobile, keyboard and screen-reader interactions are first-class.
- Cluster-managed settings retain existing read-only/live-only behavior.
- External text and tool/provider responses remain untrusted.
- Tool capability changes fail closed during unreadable configuration or migration failure.

## Verification

- Contract tests for policy migration, grants, revocation and runtime enforcement.
- Settings API tests for partial updates and concurrent writers.
- Component tests for section ownership, no duplicate controls and successful-save reconciliation.
- Browser verification at desktop and mobile widths: keyboard, hover, tap, popover focus and concise row layout.
- Search tests ensure subtitle and detailed info both locate the correct section.
- Hosts tests prove version/update surfaces exist only under Hosts after the dependency lands.
