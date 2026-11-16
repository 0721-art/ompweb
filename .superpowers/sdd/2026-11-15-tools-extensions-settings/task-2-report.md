# Task 2 report

Status: complete

Implemented the versioned tool-policy contract, resolver precedence, mandatory target gate, strict API validation, clean legacy migration, partial scoped updates, and fail-closed malformed-storage handling in the six assigned implementation/test files.

Verification:
- `bun test lib/tool-access-policy.test.mjs lib/web-settings.test.mjs lib/api-contract.test.mjs` — 50 pass, 0 fail
- `npm run typecheck` — pass
- `npx eslint lib/tool-access-policy.ts lib/tool-access-policy.test.mjs lib/web-settings.ts lib/web-settings.test.mjs app/api/web-settings/route.ts lib/api-contract.test.mjs` — pass
- `git diff --check` — pass

RED evidence:
- Policy tests initially failed because `tool-access-policy.ts` did not exist.
- Persistence tests initially failed because `toolPolicies` was absent.
- Route contract initially accepted malformed `toolPolicies`.

Self-review:
- Capability and confirmation remain separate.
- Agent overrides precede model-role overrides, which precede global policy; absent provenance does not invent a scope.
- Target denial is returned separately and always blocks the combined result.
- Scoped `inherit` is accepted only in API patches and removed from persisted records.
- Legacy fields are read for migration but removed on the next successful save; repeated saves are stable.
- Malformed policy files fail closed and a write attempt preserves the original bytes.

Known integration state:
- The pre-Task-4 GitHub/watcher consumer tests still write legacy settings patches and therefore fail against this clean storage cutover. Runtime/UI migration is explicitly outside Task 2 and must update those callers/tests before the whole repository suite can be green.
