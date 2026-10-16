---
status: passed
---

# Verification evidence

- `bun test tests/remix/ tests/dev/chatgpt-model-gateway.test.ts tests/dev-ui/development-progress.test.ts tests/contextvm/adapter.test.ts tests/phase-04/revision.test.ts`: 47 tests / 304 assertions passed; subsequently added source-snapshot gateway case and reran gateway suite: 24 tests / 123 assertions passed.
- `bun tests/dev-ui/remix-import.e2e.ts`: real Docker and SQL; safe source selection, traversal rejection, symlink/dependency exclusion, owner isolation, immutable replay, source preference, fallback and tampered blob rejection. Repeated after final importer changes, passed.
- `bun tests/dev-ui/remix-workspace.e2e.ts`: real author relay, signed directory fixture, direct-follows discovery, invalid-address blocking, no generation during resolution, 280–1280px containment, multipart encrypted CVM, owner-bound persisted input, fixture request body contains verified HTML, real worker/verifier/Paja, revision uses latest source. Passed twice, two fixture inferences per run.
- `bun test tests/dev/pre-admission-session.integration.test.ts --test-name-pattern 'save restart fund resume original operation'`: 19 assertions, including remix-reference fingerprint conflict and exact reference on resumed command; passed.
- Configured provider SQL regression: two tests / 23 assertions passed; no real provider call.
- `bun tests/dev-ui/responsive-workspace.e2e.ts`: 304 checks across 19 viewports, 280–2560px widths including 320px-height landscape. Added Remix and Explore. Screenshots under `.local/development-gui-evidence/responsive/`; inspected Explore at 320px.
- `bun tests/dev-ui/product-view.e2e.ts`: passed.
- Static build succeeded. `git diff --check` passed. Full TypeScript check: 424 baseline diagnostics, no added file/code diagnostics; this is not a clean typecheck claim.
- Default service: idle SQL check before restart; `down`/`up` returned ready at the same URL with saved ChatGPT mode and unchanged worker digest. Read-only live browser smoke: connected, Remix field validates, Explore route works, no horizontal overflow at 320px, zero model requests.

Local logs: `/tmp/cvm-remix-{final-unit,gateway-final,import-final,workspace-final,pending,api-regression,responsive,product-view,final-types}.log`. Runnable suite is now `bun scripts/dev.ts test --case=remix`, included in `--case=full`.

## Boundaries

Public GitHub snapshots only for source import; other repository hosts/private sources fall back to bounded HTML. The archive is downloaded from fixed trusted endpoints and parsed only inside the Docker VM’s isolated offline process. Live GitHub network retrieval was not required for acceptance; URL policy, archive processing, source selection and model-context behavior were tested separately. No paid inference or remote CI run. Production remains deferred.
