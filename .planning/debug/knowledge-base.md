# GSD Debug Knowledge Base

Resolved debug sessions. Used by `gsd-debugger` to surface known-pattern hypotheses at the start of new investigations.

---

## otel-approval-digest-drift — delegated approval invalidated by manifest change
- **Date:** 2026-08-05
- **Error patterns:** `APPROVAL_INPUT_DIGEST_DRIFT`, delegated approval rejection, `--verify-root-pins` exit 1
- **Root cause(s):** The Phase 07-18 package-script addition changed the full `package.json` after the Phase 07-11 delegated approval and successful smoke record were minted. The verifier intentionally binds full root-input digests, but the required immutable approval-and-smoke evidence renewal was omitted.
- **Fix:** Renewed the content-addressed delegated approval for current root inputs, updated its pointer/constant, and generated a real Collector smoke record bound to that approval.
- **Files changed:** `scripts/verify-phase-07-otel-packages.ts`, `evidence/certification/phase-07-otel-package-approval.json`, `evidence/certification/otel-package-approvals/09594baf4025de3081ec59005b529d2e031c06c38523b8c086efd97dd6e6cc7c.json`, `evidence/certification/otel-package-smokes/23991864857cc45d6557e96907a9af75084b7b29d49023fb50a8fe8d44849919.json`
- **Why not caught:** No required pre-merge gate ran the approval/root-pin verifier after the `package.json` change that invalidated the immutable evidence chain.
- **Recurrence guard:** `tests/phase-07/otel-package-legitimacy.test.ts` plus `scripts/verify-phase-07-otel-packages.ts --require-approved` and `--verify-root-pins` fail closed when the manifest no longer matches its approval and smoke evidence.
---

## release-status-contract — documented read-only release status was rejected before verification
- **Date:** 2026-08-06
- **Error patterns:** `RELEASE_CERTIFICATION_ARGUMENT_REJECTED`, `--require-state`, `--status`, missing candidate
- **Root cause(s):** The release-certification CLI parser drifted from Plan 07-20: it rejected `--require-state=<state>` and required `--candidate` before entering the read-only status branch.
- **Fix:** Added strict status-only `--require-state=<state>` parsing, the canonical repository candidate fallback for no-candidate status, and a pre-output `RELEASE_CERTIFICATION_STATE_MISMATCH` guard.
- **Files changed:** `scripts/certify-release.ts`, `tests/release/certify-release.test.ts`
- **Why not caught:** No existing release CLI regression invoked the Plan 07-20 status command without `--candidate` or asserted its required-state behavior.
- **Recurrence guard:** `tests/release/certify-release.test.ts` — `status accepts the documented require-state contract without a candidate and rejects mismatches` seeds local persisted state, verifies the exact command with `PATH` disabled, and checks mismatch fails before output.
- **Prevention:** Code branch: an option allowlist and unconditional candidate predicate were changed without an executable assertion of the documented status-only contract. Config branch: a workspace error could have blocked a routed status call but not the observed pre-workspace argument rejection; the regression seeds a confined canonical workspace. Data branch: an invalid persisted pointer/state could have blocked verification but not parser rejection; the controller's existing digest-chain checks remain exercised. The AND-gate is no: the parser defect alone caused the reported failure.
---
