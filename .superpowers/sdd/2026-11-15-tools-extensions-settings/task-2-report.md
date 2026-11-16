# Task 2 report

Status: Task 2 complete; combined Tasks 2–4 typecheck awaits Task 4 consumer migration.

Implemented the versioned tool-policy contract, resolver precedence, mandatory target gate, strict API validation, clean legacy migration, partial scoped updates, and fail-closed malformed-storage handling in the six assigned implementation/test files.

Verification:
- `bun test lib/tool-access-policy.test.mjs lib/web-settings.test.mjs lib/api-contract.test.mjs` — 53 pass, 0 fail
- `npx eslint lib/tool-access-policy.ts lib/tool-access-policy.test.mjs lib/web-settings.ts lib/web-settings.test.mjs app/api/web-settings/route.ts lib/api-contract.test.mjs` — pass
- `npm run typecheck` — expected combined-gate failure: eight `lib/rpc-manager.ts` references to removed `WebServerSettings.agentToolsEnabled`; Task 4 must migrate them before approval
- `git diff --check` — pass

RED evidence:
- Policy tests initially failed because `tool-access-policy.ts` did not exist.
- Persistence tests initially failed because `toolPolicies` was absent.
- Route contract initially accepted malformed `toolPolicies`.
- Review round 1 tests failed before fixes because invalid legacy Actions values migrated to ask, legacy save patches were accepted, and unsafe scope IDs were accepted.

Self-review:
- Capability and confirmation remain separate.
- Agent overrides precede model-role overrides, which precede global policy; absent provenance does not invent a scope.
- Target denial is returned separately and always blocks the combined result.
- Scoped `inherit` is accepted only in API patches and removed from persisted records.
- Legacy fields are read only when `toolPolicies` is absent. The next successful save writes normalized policies and removes legacy keys; repeated saves are stable. Invalid Actions containers, keys, or values migrate all three Actions capabilities disabled.
- Malformed policy files fail closed and a write attempt preserves the original bytes. Persistence and API boundaries reject legacy patch keys before changing stored bytes.

Known integration state:
- The pre-Task-4 GitHub/watcher consumer tests still write legacy settings patches and therefore fail against this clean storage cutover. Runtime/UI migration is explicitly outside Task 2 and must update those callers/tests before the whole repository suite can be green.

## Contract

Capability IDs, exactly:

- `omp.bash`
- `omp.extension_requests`
- `ompweb.agent_tools`
- `ompweb.session_start`
- `browser.open_url`
- `github.read_watch`
- `github.discussions`
- `github.actions.dispatch`
- `github.actions.cancel`
- `github.actions.rerun`

Persisted schema:

```ts
toolPolicies: {
  version: 1;
  global: Partial<Record<CapabilityId, OperationPolicy>>;
  modelRoles: Record<ScopeId, Partial<Record<CapabilityId, OperationPolicy>>>;
  agents: Record<ScopeId, Partial<Record<CapabilityId, OperationPolicy>>>;
}
```

Patch schema:

```ts
toolPolicies?: {
  version?: 1;
  global?: Partial<Record<CapabilityId, OperationPolicy>>;
  modelRoles?: Record<ScopeId, Partial<Record<CapabilityId, OperationPolicy | "inherit">>>;
  agents?: Record<ScopeId, Partial<Record<CapabilityId, OperationPolicy | "inherit">>>;
}
```

`inherit` is scoped-patch-only and deletes the selected override; it is never persisted. Scope IDs match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, exclude `__proto__`, `prototype`, and `constructor`, and are materialized in null-prototype maps.

Migration timing: if `toolPolicies` exists, it is authoritative and must validate. Otherwise reads derive policies from the three legacy settings without modifying disk. A successful save writes only the normalized version-1 schema. Invalid or unreadable storage fails closed and is not replaced.
