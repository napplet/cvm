---
type: quick
status: complete
---

# Current napplet authoring skills in development generation

Replaced the retired development-worker npm skills installer with six official skills installed by `npx skills@1.7.2 add` from `napplet/napplet` commit `efc647642c9bd80aed58af139bf90910e68e962c`: make, design, UI, build, SDK and test. Upstream text, MIT license, installer lockfile and SHA-256 manifest are committed together.

Both development model gateways now include the installed guidance before source generation. The original worker-only installation happened after model completion and could not inform a Responses request. The worker copies the same snapshot into `/work/.agents/skills` offline. Readiness validates host/image guidance and loader hashes before admission. Request byte ceilings still include all guidance and framing; replay fences and bounded source-only outputs remain enforced.

`bun scripts/update-dev-skills.ts <full-commit-sha>` deliberately refreshes the snapshot through the skills CLI in a temporary directory. Normal startup and e2e use the committed snapshot. Root package.json and bun.lock are unchanged. Production compatibility/promotion evidence was not rewritten.

## Verification

- OAuth, model-request, replay and authoring-integrity tests: 37 passed, 163 assertions.
- Configured-provider fixture integration: 2 passed, 23 assertions; no real API request.
- Runtime readiness: real image and both Chromium runtimes pass; wrong platform and changed host code remain rejected.
- Initial composed OAuth e2e passed the full browser → relay → SQL → Docker → Paja flow, including revision, restart, replay, failure diagnostics and settlement.
- Final composed OAuth e2e with optional SDK theme calls passed: three successful versions, replay/restart, deliberate TypeScript failure and uncertain usage-limit outcome, with exactly-once settlement.
- Live ChatGPT subscription smoke passed after the optional-initialization guidance correction: generated source, verified artifact, sandboxed preview and Add → 1; no API credentials and no automatic retries.
- Worker image `sha256:de55a99223cf5ecb72172f07998e582c57aa2db0da7b6fe82d779622bf7bd314`; standard GUI restarted at http://127.0.0.1:49371 with saved subscription selection intact. Active actions were checked before each restart.

## Findings and limits

The first live generation built and type-checked but exposed an upstream conformance theme stub: a valid SDK call threw synchronously because the mock advertised a domain without its methods. CLI 0.3.4 reproduced the same issue in a disposable candidate, so that upgrade was discarded. The service contract now requires optional SDK initialization to handle synchronous exceptions as well as rejected Promises while retaining the local UI. A local copy of the saved source with that fallback passed every worker stage; the original failed immutable proposal and settlement were preserved. A new live action then passed.

A separate Paja probe found that the preview's disabled-by-default domain policy exposed only `shell`, even after enabling the theme toggle. Enabled theme integration remains unverified and documented in the development runbook. The fixture exercises fallback behavior with capabilities absent; this task does not claim to repair Paja's domain toggle or enable runtime permissions. No conformance checks were disabled, no generated source was silently rewritten, and no production release authority was granted.

Implementation commit: `544d953`. Completed 2026-10-16T01:54:53Z (2026-10-15 local).
