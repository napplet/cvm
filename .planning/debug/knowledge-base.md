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

## release-status-contract-follow-on — asserted status did not compose in the Plan shell check
- **Date:** 2026-08-06
- **Error patterns:** matching `--require-state` exits 1, `authorization_required`, `&&`, `authorization receipt|changed scope|expired|cost ceiling` matches 0 tests
- **Root cause(s):** `scripts/certify-release.ts` returned the controller's nonzero authorization-boundary exit code after a matching explicit state assertion; `tests/release/controller.test.ts` had no test name selected by the documented Plan 07-20 filter.
- **Fix:** Return 0 only when `--status --require-state=<state>` has matched; preserve nonzero normal/mismatch/missing/invalid status behavior; add a pure local authorization receipt integrity test named for the documented filter terms.
- **Files changed:** `scripts/certify-release.ts`, `tests/release/certify-release.test.ts`, `tests/release/controller.test.ts`
- **Why not caught:** The earlier parser regression verified matching JSON and mismatch failure but not shell-success exit semantics, and the Plan's literal test-name filter was not run as an executable acceptance check.
- **Recurrence guard:** `tests/release/certify-release.test.ts` — `status require-state exits zero only on the documented exact match`; `tests/release/controller.test.ts` — `authorization receipt integrity rejects changed scope, expired receipt, and cost ceiling tampering before effects`; the exact Plan 07-20 combined command is now executable.
- **Prevention:** Code branch: a controller-level authorization boundary exit code and a CLI-level assertion-success exit code serve different contracts; test both. Test-contract branch: literal `--test-name-pattern` verification commands must select at least one relevant test. Config/environment branch: the status test confines its workspace and disables PATH, so provider availability cannot mask the contract. The AND-gate is yes: both independent defects had to be fixed for the `&&`-joined Plan command to pass.
---

## 07-20-discovery-registry — dry-run discovery diverged from the complete provider registry
- **Date:** 2026-08-06
- **Error patterns:** `UNSUPPORTED_CAPABILITY`, zero account scope, unavailable discovery, non-actionable v2 authorization request, `createNativeReleaseDiscoveryRegistry`
- **Root cause(s):** `createNativeReleaseDiscoveryRegistry` kept a legacy six-provider map after the 16-family production composition was added. Its fallback returned unsupported/zero observations for the ten implemented omitted families, and it had no canonical candidate digest from which to derive safe required-scope/cost bindings.
- **Fix:** Replaced the fallback with immutable all-family profiles, candidate-bound redacted scope/cost descriptors, and explicit authorization blocks; retained authenticated Google/Modal/Fly account hashes; bound dry-run/request/receipt CLI discovery to the controller's canonical candidate SHA.
- **Files changed:** `src/release/native-discovery.ts`, `src/release/controller.ts`, `scripts/certify-release.ts`, `tests/release/native-discovery.test.ts`, `tests/release/certify-release.test.ts`
- **Why not caught:** Native discovery tested the obsolete unsupported fallback while production composition separately tested all sixteen families; no test inspected the complete persisted dry-run request.
- **Recurrence guard:** `tests/release/native-discovery.test.ts` covers every `RELEASE_PROVIDER_IDS` member, preserves authenticated Google/Modal/Fly hashes, and proves request regeneration; `tests/release/certify-release.test.ts` asserts all sixteen persisted account/project scopes are nonzero under PATH-disabled no-effect execution.
---

## release-production-command-bridge — non-dry CLI stopped before exact authorization
- **Date:** 2026-08-06
- **Error patterns:** `RELEASE_PRODUCTION_CAPABILITY_OR_CONSENT_REQUIRED`, `RELEASE_AUTHORIZATION_REQUIRED`, non-dry command, empty blocked registry, missing release-session configuration
- **Root cause(s):** The non-dry CLI passed only a receipt digest and `runReleaseCertification` constructed an all-blocked native registry then unconditionally threw, never invoking `executeAuthorized`. There was no one-config bridge for the exact structured receipt, same all-family registry, real protected ports, materialization, worker selection, and finalization inputs required by the controller.
- **Fix:** Added a protected-config, SHA-256-pinned `createReleaseExecutionSession` module boundary. The command uses its one session for discovery and authorized execution; local, absent, and credential-unavailable configurations stop with `RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED` before module loading or provider interaction.
- **Files changed:** `scripts/certify-release.ts`, `src/certification/config.ts`, `src/release/controller.ts`, `src/release/production-execution.ts`, `tests/release/certify-release.test.ts`, `tests/release/production-execution.test.ts`, `tests/phase-07/certifier-config.test.ts`, `docs/runbooks/release-certification.md`
- **Why not caught:** Existing tests accepted the generic all-blocked stop instead of asserting that the non-dry product command reaches the issued-request authorization boundary while still forbidding mutation before an exact receipt.
- **Recurrence guard:** `tests/release/production-execution.test.ts` verifies hash-pinned session loading makes no provider call, local/credential-unavailable configuration stops before module loading, and non-dry execution reaches preparation but rejects an invalid receipt before plan or mutation. `tests/release/certify-release.test.ts` checks the local command's explicit fail-closed error.
- **Prevention:** Code branch: keep the product command wired through the same controller state machine rather than adding a separate non-dry sentinel. Config branch: require one protected config pin and refuse local/unavailable credentials before dynamic import. Environment branch: the deployment-owned factory, external clients, and real evidence ports remain intentionally absent from the repository and must not be inferred from test fakes. Data branch: a receipt digest is not an exact structured approval receipt. The AND-gate is yes for live execution: the bridge and a deployed trusted factory are both required. This session resolves only the bridge; live readiness remains a planned blocker until a factory supplies the 16 authorized ports, eight `evidenceClass: real` ports, materialization/worker selection/finalization inputs, and the official receipt.
---
