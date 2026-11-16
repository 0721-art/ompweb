# Task 4A report

## Implemented

- Added one generic runtime authorizer over `resolveToolPolicy` and the approval store. It validates optional caller `agentId` / `modelRole`, applies agent > model-role > global precedence, enforces mandatory target denial, rechecks cancellation and policy after confirmation, and remembers only stable resource identities.
- Cut GitHub read/watch, discussions, dispatch, cancel and rerun over independent capability grants keyed by session and normalized repository. Confirmation text names the capability, repository and session scope. Disabled local policy fails before invoking `gh`; provider failures do not mutate policy.
- Migrated host agent-start storage from `allowAgentStart` to mandatory `agentStartPolicy`, with legacy `false -> enabled+ask`, `true -> enabled+allow`, and explicit deny support. Caller policy cannot bypass a disabled target. Local cross-host starts retain their mandatory confirmation.
- Added optional validated caller provenance to ompweb host-tool frame/context plumbing. Absent caller resolves globally; no role inference is performed.
- Removed runtime compatibility readers for `agentToolsEnabled`, `githubWritesUnasked`, Actions tri-state settings and bare host booleans. Watcher, outbox, RPC, Hosts API/UI, and existing Settings controls now consume/write `toolPolicies` or `agentStartPolicy`.
- Preserved replay-safe tool allowlisting, unknown-outcome fences, action receipts and host-tool cancellation checks.
- Bash is rejected by the approval store and the runtime authorizer never reads or writes a Bash grant.

## Security self-review

- Scoped caller IDs use the same bounded/prototype-safe shape as persisted policy scope IDs; malformed provenance is rejected rather than inferred.
- Target-host disabled policy is checked independently from caller policy. Target `ask` also requires confirmation even when caller policy is `allow`.
- GitHub capability policy is checked before provider access, but grants are created only after the existing `gh` availability/read validation, so provider refusal cannot change local authority.
- GitHub repository grant keys are normalized case-insensitively. Capability IDs remain part of the approval key, preventing read/discussion/dispatch/cancel/rerun escalation.
- Confirmation cancellation and post-confirmation policy revocation are checked before grants and mutations. Existing action receipt and replay fences remain intact.

## Verification

- `bun test --timeout 30000 lib/tool-policy-runtime.test.mjs lib/github/tools.test.mjs lib/github/action-tools.test.mjs lib/hosts/registry.test.mjs lib/hosts/hosts-route.test.mjs lib/github/watcher.test.mjs lib/message-outbox.test.mjs components/SettingsConfig.github-actions.test.mjs components/SettingsConfig.github-writes.test.mjs` — 184 pass, 1 skip, 0 fail.
- `bun test --timeout 30000 lib/agent-tools.test.mjs` — 35 pass, 0 fail.
- `bun test --timeout 30000 lib/rpc-manager.test.mjs` — 158 pass, 0 fail.
- `bun test --timeout 30000 lib/web-settings.test.mjs lib/api-contract.test.mjs app/api/tool-approvals/route.test.mjs` — 48 pass, 0 fail.
- `bun test --timeout 30000 components/SettingsConfig.github-actions.test.mjs components/SettingsConfig.github-writes.test.mjs` — 7 pass, 0 fail.
- `npm run typecheck` — pass.

## BLOCKED follow-ons

### Task 4B: browser URL-origin authorization protocol

`open_url` executes in the browser and its existing confirmation dialog completes after ompweb has already returned the host-tool result. The server-owned approval store has no authenticated check/grant handshake tied to that confirmation and cancellation lifecycle. Adding a browser POST that grants authority would create a second, forgeable authorization path, so no such endpoint or client-only remembered approval was retained. Existing browser confirmation behavior remains unchanged. Completion requires a protocol in which the server issues a bounded pending authorization, the browser answers that exact request, and the server atomically rechecks policy/cancellation before recording `(session, url.origin, origin, browser.open_url)`.

### Task 4C: authoritative extension identity

Current ompweb extension UI/request frames expose no validated stable extension identity suitable for the grant key. Inventing identity from display text or tool names would allow collisions and privilege confusion. Existing native extension ask/allow behavior remains unchanged and no extension grant is recorded. Completion requires upstream OMP to carry an authoritative extension identity through its request frame and ompweb runner channel; Task 1B must then validate and pass it to the runtime authorizer.

## Fix round 1

- Persisted validated caller agent/model-role provenance with every watch and rechecked the effective read/watch policy plus session/repository grant before fetch, pending delivery, outbox admission and cursor mutation. Revocation now removes pending watches and cannot be resurrected by re-enabling policy.
- Reloaded target-host policy by host ID during authorization and immediately before startup. Missing or malformed target records fail closed.
- Applied `ompweb.session_start` caller policy and mandatory target policy to cold `send_to_session` delivery on local, same-host and cross-host paths.
- Made a present malformed `agentStartPolicy` deny without consulting legacy `allowAgentStart`; the original registry bytes remain untouched.
- Serialized initial/final authorization and grant insertion with the existing cross-process settings lock. The final check uses the current legal session identity and is atomic against policy revocation.
- Removed the old `ompweb.agent_tools` ceiling from GitHub/session-start operations. Registration remains available when any applicable global, role or agent capability is enabled.
- Added cancellation checks before allow/grant success and immediately before mutations after awaited work.
- Host deny and allow-to-ask transitions revoke matching remembered host-start grants before registry persistence.
- Successful authoritative settings responses now reconcile Agent tools, GitHub discussions and all Actions sibling controls through one in-page policy event.

Fix-round verification:

- `bun test --timeout 30000 lib/agent-tools.test.mjs lib/tool-policy-runtime.test.mjs lib/tool-approval-store.test.mjs lib/hosts/registry.test.mjs lib/github/tools.test.mjs lib/github/action-tools.test.mjs components/SettingsConfig.github-actions.test.mjs components/SettingsConfig.github-writes.test.mjs` — 122 pass, 0 fail.
- `bun test --timeout 30000 lib/github/watcher.test.mjs lib/message-outbox.test.mjs` — 86 pass, 0 fail.
- `bun test --timeout 30000 lib/rpc-manager.test.mjs` — 158 pass, 0 fail.
- `bun test --timeout 30000 lib/hosts/hosts-route.test.mjs lib/hosts/local-bootstrap.test.mjs` — 35 pass, 1 skip, 0 fail.
- `npm run typecheck` — pass.
- Scoped ESLint over the 15 changed implementation files — pass.

## Fix round 2

- Persisted watcher authorization in durable watch rows and encoded the same bounded caller/repository identity into queued native outbox ownership. Cold-start pumping and every native-delivery boundary recheck effective caller policy plus grant; unauthorized entries retire and cannot resume after re-enable.
- Added explicit non-provider-mutating system-notice delivery for watcher pause/resume notifications while normal watch batches remain grant-gated.
- Reauthorized host starts after cwd validation, pooled preparation, each initialization await and immediately before spawning. Cold sends reauthorize after discovery/startup and immediately before native delivery.
- Serialized host policy read/revoke/write narrowing with the same cross-process tool-policy lock as final grant authorization; a deterministic two-process test proves narrowing waits for a concurrent final grant and then revokes it.
- Added a shared successful-response generation fence so late initial settings GETs cannot overwrite a newer PUT response across Agent tools, discussions or Actions controls.

Fix-round verification:

- `bun test --timeout 30000 lib/agent-tools.test.mjs` — 36 pass, 0 fail.
- `bun test --timeout 30000 lib/message-outbox.test.mjs lib/github/watcher.test.mjs components/SettingsConfig.github-actions.test.mjs components/SettingsConfig.github-writes.test.mjs` — 93 pass, 0 fail.
- `bun test --timeout 30000 lib/rpc-manager.test.mjs` — 158 pass, 0 fail.
- `bun test --timeout 30000 lib/hosts/registry.test.mjs lib/hosts/hosts-route.test.mjs lib/hosts/local-bootstrap.test.mjs` — 52 pass, 1 skip, 0 fail.
- `bun test --timeout 30000 components/SettingsConfig.github-actions.test.mjs components/SettingsConfig.github-writes.test.mjs` — 8 pass, 0 fail.
- `npm run typecheck` — pass.
- Scoped ESLint — pass.

## Fix round 3

- Added monotonic per-capability authorization generations under the existing cross-process policy lock. Narrowing bumps the generation before revocation; durable watch rows and queued native watch deliveries retain the generation and cannot revive after disable/ask then re-enable. Legacy unversioned watch ownership fails closed.
- Reauthorization now reaches the actual execution boundaries after cwd validation, pooled project/config preparation, cold-session startup, transcript/upload fences and immediately before native spawn/send.
- Initial settings GET continuations are generation-fenced at their final setters, so a successful PUT response cannot be overwritten by a late initial response.

Fix-round verification:

- `bun test --timeout 30000 lib/github/watcher.test.mjs lib/message-outbox.test.mjs lib/hosts/registry.test.mjs components/SettingsConfig.github-actions.test.mjs components/SettingsConfig.github-writes.test.mjs` — 111 pass, 0 fail.
- `bun test --timeout 30000 lib/agent-tools.test.mjs` — 36 pass, 0 fail.
- `bun test --timeout 30000 lib/rpc-manager.test.mjs` — 158 pass, 0 fail.
- `npm run typecheck` — pass.
- Scoped ESLint — pass.

## Fix round 5 (final boundary corrections)

- Watch authorization now carries the watch row's original policy generation through delivery and post-discovery outbox admission. Admission checks that generation and the effective policy under the existing cross-process lock, persists the exact authorization unchanged, and fails legacy unversioned watcher admissions closed. The deterministic host-lookup release test disables then re-enables policy and proves the stale admission remains refused.
- Reused the existing pre-send authorization/cancellation callback through `runAgentCommand`, `startRpcSession`, and `Host.spawnRpc`; it runs after send/upload fences, orphan/config/pool preparation, and immediately before native send/open/spawn. The Hub strips the callback from the wire payload. No second policy path was added.
- Removed redundant initial Settings GET final setters; the shared policy publisher already owns updates. An exact microtask interleaving proves the late initial GET cannot overwrite the successful PUT.
- Kept the existing explicit Task 4B browser-origin protocol and Task 4C authoritative-extension-identity blockers unchanged; no alternate grant paths were added.

Final verification:

- `bun test --parallel --timeout 30000 lib/tool-policy-runtime.test.mjs lib/github/watcher.test.mjs lib/message-outbox.test.mjs lib/hosts/hub-v7.test.mjs lib/agent-tools.test.mjs lib/rpc-manager.test.mjs components/SettingsConfig.github-actions.test.mjs components/SettingsConfig.github-writes.test.mjs` — 359 pass, 0 fail.
- `npm run typecheck` — pass.
- `npx eslint components/SettingsConfig.tsx components/SettingsConfig.github-actions.test.mjs lib/agent-command.ts lib/github/watcher.ts lib/hosts/host.ts lib/hosts/hub.ts lib/hosts/hub-v7.test.mjs lib/hosts/local-host.ts lib/message-outbox.test.mjs lib/message-outbox.ts lib/rpc-manager.ts lib/tool-policy-runtime.ts` — pass.

## Task 4D: fresh-session reset authorization boundary

- Reused the existing startup authorizer immediately after the awaited `sessionFileExists` lookup and immediately before the native `new_session` send. Cancellation or policy revocation during the lookup now aborts startup without sending the session mutation; no policy API or alternate authorization path was added.
- Added a deterministic deferred-lookup regression that revokes authorization while the lookup is pending and asserts startup rejects without a native `new_session`.
- Preserved the existing startup error disposal and delivery-outcome behavior by allowing the authorizer rejection to follow the existing failure path.

Task 4D verification:

- RED: `bun test --timeout 30000 lib/rpc-manager.test.mjs --test-name-pattern 'revocation during a fresh-session file lookup'` — failed with `Missing expected rejection`.
- GREEN: the same focused command — 1 pass, 158 filtered, 0 fail.
- `bun test --timeout 30000 lib/rpc-manager.test.mjs` — 159 pass, 0 fail.
- `npm run typecheck` — pass.
- `npx eslint lib/rpc-manager.ts lib/rpc-manager.test.mjs` — pass.
