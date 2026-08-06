---
status: resolved
trigger: "Phase 7 setup must be controller-owned, but release:certify is hard-wired to dry-run and cannot discover provider-native authentication."
created: 2026-08-06T13:30:00Z
updated: 2026-08-06T19:31:00Z
---

# Debug Session: Release certifier live path

## Symptoms

- **Expected:** `release:certify` discovers provider-native authenticated account scopes without exposing credentials, stops for one exact cost/effect approval, and then resumes the same authorized controller run through Plan 07-26.
- **Actual:** `scripts/certify-release.ts` always calls `runReleaseCertification(... dryRun: true)` and constructs no authenticated provider registry, so all sixteen capabilities remain unavailable and the non-dry-run command cannot advance.
- **Errors:** The dry run remains `authorization_required` with `CREDENTIALS_UNAVAILABLE` for every provider; the absence of provider ports is reported as user setup despite no usable setup interface.
- **Timeline:** Discovered after Plan 07-25 completed its candidate-only local orchestration and the first real Plan 07-20 authentication attempt began.
- **Reproduction:** Run `bun run release:certify -- --candidate toolchains/candidates/initial.json` with or without provider CLI sessions; output remains the same dry-run authorization boundary.

## Current Focus

- **bug_class:** bohrbug — the same `release:certify --request` input deterministically emits the fixture-catalog sources and a 158-micro maximum regardless of the authenticated-readiness environment.
- **hypothesis:** The product CLI calls `dryRun()` without a live cost catalog, so the controller's test-only candidate fixture fallback always generates 16 synthetic lines (1–16 plus 10% headroom = 158); separately, it labels non-launchable owner-signature/operator-rail prerequisites as generic consent launches and returns `null` when its pinned execution factory is unavailable.
- **test:** Re-run the agent-authored product regression after restoring the scoped source changes, then run the TypeScript check to identify whether any diagnostics originate in these files.
- **expecting:** The target regression passes again; any broad TypeScript diagnostic not in the changed release files is recorded as pre-existing rather than hidden.
- **next_action:** Run the target CLI test, then `bunx tsc --noEmit --pretty false` with bounded output. Do not invoke any provider CLI, authorization callback, effect executor, publication, cleanup, or live resource command.
- **known_pattern_candidate:** none — semantic recall unavailable; keyword fallback found no two-token match in the knowledge base.
- **reasoning_checkpoint:**
  **hypothesis:** "`scripts/certify-release.ts` does not pass a current-price catalog to the controller, and `ReleaseCertificationController.dryRun()` silently replaces that missing authority with candidate-bound fixture prices; the same CLI presentation treats future owner signing and operator funding setup as launchable consent."
  **confirming_evidence:**
    - "The controller's only fallback names every source `${provider}-fixture-catalog`, assigns `priceMicros: index + 1`, and applies a 10% headroom; those deterministic values sum to the reported 158 micros."
    - "The product CLI provides a native capability registry but no `costCatalog`, so its `dryRun()` call necessarily selects the fallback."
    - "`preparePendingConsentLaunchDescriptors()` emits only channel, request hash, and expiry for NIP-46, NWC, and Cashu; local config makes the top-level readiness value `null`."
    - "The supplied redacted environment evidence shows a read-only GCP catalog prerequisite can be tested but all sixteen current authoritative price facts are not configured, so a real exact request cannot be made honestly."
  **falsification_test:** "If a product `--request` with no injected current-price catalog already blocks before persisting/printing a request, or if its output already represents the owner-signature and operator-funding distinctions without generic launch descriptors, this diagnosis is false."
  **fix_rationale:** "Require an injected current-price catalog on the product path and return a bounded `preapproval_blocked` projection when it is absent; retain the fixture catalog only for explicitly injected local/test controller use. Replace generic launch descriptors with explicit, non-executable prerequisite descriptors: future-owner NIP-46 signing is deferred to publication, while exactly one operator funding rail (NWC or Cashu) must be selected before approval. Return a structured blocked factory-readiness result instead of `null`."
  **blind_spots:** "No current all-family production price catalog, pinned protected factory, operator funding rail, or future owner identity is configured; this fix must report these as blockers and cannot establish a live-ready request."
  **candidate_causes:**
    - "code: CLI omits the current-price catalog and controller supplies synthetic fixture cost facts."
    - "code: consent descriptor semantics conflate non-executable future signer/operator prerequisites with user consent launches."
    - "config: local certifier mode provides no pinned protected execution factory or selected operator funding rail."
    - "environment/data: the authenticated account may read public GCP metadata but has no configured target project, and authoritative current price facts for all sixteen families are absent."
  **and_gate:** "no — the fixture-priced request is fully caused by the code fallback/composition defect; missing production configuration explains why the correct post-fix result is blocked rather than ready, but is not needed to reproduce the erroneous synthetic request."

## Evidence

- **timestamp:** 2026-08-06T12:29:23Z
  **checked:** Debug knowledge base and semantic-recall capability.
  **found:** The only resolved session concerns OpenTelemetry approval-digest drift; it has no two-token overlap with provider authentication, certification CLI composition, or dry-run behavior. No MemPalace CLI/MCP result was available in this debugger context, so keyword fallback was used.
  **implication:** There is no known prior resolution to assume; investigate the current CLI composition directly.

- **timestamp:** 2026-08-06T12:29:23Z
  **checked:** Persisted symptom reproduction and supplied live-setup evidence.
  **found:** The reported invocation deterministically stays at `authorization_required`; authenticated provider CLIs are present, but provider login callbacks remain pending and must not be inspected or mutated. Any implementation must retain only hashed account scopes, cost-estimate digests, and secret-reference names.
  **implication:** This is a deterministic product-composition failure (Bohrbug), not a credential or provider-login incident; regression tests must prove redaction and authorization gating.

- **timestamp:** 2026-08-06T12:31:00Z
  **checked:** Codebase knowledge graph for certification composition.
  **found:** The graph locates the central controller (`src/release/controller.ts`), provider registry (`src/release/providers.ts`), contracts (`src/release/contracts.ts`), and a `runReleaseCertification` call path, confirming the symptom is in the release composition layer rather than the provider CLIs.
  **implication:** Inspect the entry script and these complete modules before making any change; provider-session probing is neither needed nor authorized to establish the code-path defect.

- **timestamp:** 2026-08-06T12:33:00Z
  **checked:** Graph trace from `runReleaseCertification` through the controller and provider registry.
  **found:** `runReleaseCertification` accepts only `{ dryRun: true }` and calls `certify()`, whose own comment and implementation call `dryRun()` then stop at `authorization_required`. `ReleaseProviderRegistry.discover()` parses native capability/authentication but writes literal zero digests and `[]` for all redacted discovery metadata.
  **implication:** Two code defects jointly prevent a safe live path: no live dispatch is reachable and valid provider discovery evidence is erased. The required fix must address both without adding an unauthorised mutation path.

- **timestamp:** 2026-08-06T12:36:00Z
  **checked:** Plan 07-25/07-26 contract and complete release entry/controller/provider sources.
  **found:** Plan 07-26 is explicitly run-only and says a discovered runtime defect requires a separate atomic fix that preserves the gate. The shipped 07-25 script accepts no authorization-receipt input, constructs `ReleaseCertificationController` without a provider registry, and passes literal `dryRun: true`; the supplied provider registry owns all sixteen provider IDs but discards the three allowed redacted discovery fields. The existing local tests deliberately assert the prior candidate-only boundary.
  **implication:** A narrow production fix is required before any live run: provider-native read-only discovery must be composed by the product command; non-dry-run execution must remain unreachable without a validated exact receipt; any unimplemented provider family must be visible and fail closed.

- **timestamp:** 2026-08-06T12:40:00Z
  **checked:** Local release/controller/provider-discovery suite (`bun test tests/release/certify-release.test.ts tests/release/controller.test.ts tests/release/provider-discovery.test.ts`).
  **found:** All 16 tests pass. There is no failing test for spectrum-based fault localization, so SBFL is skipped. Git history shows the current behavior was introduced deliberately as the Plan 07-25 candidate-only contract, so there is no prior product live implementation to bisect.
  **implication:** The test suite confirms a coverage gap rather than contradicting the diagnosis. Use specified-contract regression tests (not an implicit no-crash oracle); no input shrinker is applicable because the defect is fixed control-flow composition, not an input-space class.

- **timestamp:** 2026-08-06T12:42:00Z
  **checked:** Updated architecture/provider constraint from the coordinating agent.
  **found:** Google Cloud (including Cloud Run/GCS/gcloud) and CockroachDB/ccloud are excluded. Modal and Fly remain allowed. No cloud-specific code or probes have been made in this session.
  **implication:** The fix is restricted to provider-neutral composition plus Modal/Fly descriptors; every other currently declared provider family remains explicitly unimplemented and fail-closed pending the architecture repair.

- **timestamp:** 2026-08-06T12:44:00Z
  **checked:** Latest coordinating-agent scope update.
  **found:** Google Cloud is restored as an approved discovery-only exception for gcloud/Cloud Run/GCS/Collector. CockroachDB/ccloud remains excluded. The coordinating agent owns architecture, provider-ID, and plan repair.
  **implication:** The narrow fix may include static gcloud, Modal, and Fly read-only probe descriptors but will not touch provider IDs, topology, plans, Cockroach/ccloud, or provider mutation code.

- **timestamp:** 2026-08-06T12:47:00Z
  **checked:** Coordinating-agent architecture correction.
  **found:** The current `cockroach_postgres` provider identifier must be replaced with `cloud_sql_postgres`; Cloud SQL is an approved gcloud discovery-only target, while CockroachDB/ccloud remains excluded. The requested rename is limited to release contracts/topology/effect ownership/tests.
  **implication:** Fold the small identifier correction into this atomic fix, preserve the no-mutation boundary, and do not modify provider plans or introduce ccloud probing.

- **timestamp:** 2026-08-06T12:50:00Z
  **checked:** Redacted active-setup discovery context and controller dry-run resume logic.
  **found:** Approved gcloud authentication and a redacted account-scope digest are available, but the default workspace contains an older all-unavailable request. `dryRun()` calls `status()` and returns an existing matching candidate/topology/effect request before it discovers providers, so an authenticated scope change cannot update the current request without manual deletion.
  **implication:** The fix must re-run read-only discovery before accepting an existing pending request, retain it only when its canonical capability inventory matches, and otherwise atomically write a new discovery/request/state chain and update the controller pointer. It must never display or hardcode the actual account/project identity.

- **timestamp:** 2026-08-06T12:54:00Z
  **checked:** First execution of the new focused regression suite.
  **found:** Native metadata preservation passes. Remaining failures identify three implementation details: `AVAILABLE` is not an allowed controller capability reason, the old workspace's state cannot parse after the approved provider-ID migration, and non-dry-run correctly stops first for a missing authorization digest. Cloud SQL is now an approved gcloud probe, so its old test expectation of unsupported is invalid.
  **implication:** These are direct implementation/test alignment findings, not a changed root cause. Correct the controller schema/default generation and retain the strict order: exact digest required before the explicit unavailable-live-executor failure.

- **timestamp:** 2026-08-06T13:00:00Z
  **checked:** Review of the approved gcloud discovery design.
  **found:** Hashing an active account alone permits selected-project drift to retain the wrong authorization scope, and a configured CLI does not prove Application Default Credentials remain usable. The initial Modal/Fly scope is insufficient for gcloud's project-bound effect plan.
  **implication:** The gcloud command must validate ADC by discarding the access-token output, and it must hash account-plus-selected-project inside the shell before outputting only a digest. Regression coverage must treat a changed scope digest or unavailable ADC as a new authorization request, never as a resumable prior request.

- **timestamp:** 2026-08-06T13:03:00Z
  **checked:** Focused release regression suite and TypeScript diagnostics scoped to the changed release files.
  **found:** All 21 focused tests pass, including valid `AVAILABLE` observations, finite metadata preservation, gcloud account-plus-project/ADC command shape, stale-scope regeneration, revoked-ADC regeneration, and explicit unavailable-live-executor failure. `tsc --noEmit` reports no diagnostics in the changed release files; its nonzero exit is due to pre-existing errors elsewhere in the repository.
  **implication:** The root-cause behavior is covered by specified-contract tests. Continue with full adjacent test coverage and the fix-acceptance guardrail; no live credential or provider mutation test is needed or authorized.

- **timestamp:** 2026-08-06T13:05:00Z
  **checked:** Full local test suite (`bun test`).
  **found:** 554 tests across 89 files passed with zero failures. The new `AVAILABLE` capability reason and Cloud SQL provider-ID correction did not break adjacent certification, promotion, or release behavior.
  **implication:** Adjacent-test guardrail signal is currently passing. Next validate that the focused regression test genuinely detects removal of this fix and inspect the diff for behavior-deleting changes.

- **timestamp:** 2026-08-06T13:08:00Z
  **checked:** Redacted observation from the product's read-only Fly CLI probe.
  **found:** `flyctl auth whoami` succeeds under the user's normal environment but returns `not_configured` from the native factory because its child process receives only `PATH`, omitting `HOME` and other approved CLI configuration locators. No credential value was exposed.
  **implication:** Pass only non-secret locator variables (`PATH`, `HOME`, optional config-directory/profile locators) into probe children; explicitly omit all token and credential variables. This preserves read-only authentication discovery without broad environment inheritance.

- **timestamp:** 2026-08-06T13:11:00Z
  **checked:** Focused release suite after locator-environment correction and the authorized read-only `release:certify -- --dry-run` command.
  **found:** All 22 focused tests pass. The product dry-run regenerated the controller-owned pending request and exited nonzero at `authorization_required` as intended; its public output contained only controller/request digests, not account/project IDs, token values, or provider command output.
  **implication:** Native discovery is now active on the product preflight while live mutation remains blocked. Read a sanitized status projection to validate discovery outcomes, then finish the guardrail without further provider interaction.

- **timestamp:** 2026-08-06T13:12:00Z
  **checked:** Sanitized capability projection from the regenerated controller state.
  **found:** Cloud Run, GCS, Collector, Cloud SQL, Modal, and Fly each report `available` + `authorized` with non-zero scope/cost digests and one redacted reference name. No raw account, project, token, or reference value was read or printed.
  **implication:** The read-only product composition discovers the approved configured families correctly. The other provider families remain explicit unsupported facts, so the non-dry-run path must continue to fail closed.

- **timestamp:** 2026-08-06T13:16:00Z
  **checked:** Fix-acceptance revert-and-reconfirm experiment.
  **found:** After stashing only the six production paths for this fix, the 22-test focused suite failed as predicted: the native discovery module was absent, provider metadata was zeroed/unavailable, changed scope reuse was not invalidated, and non-dry-run was still indistinguishable from the old dry-run path. Restoring exactly those source paths made all 22 focused tests pass again.
  **implication:** The regression suite detects the actual changed production behavior rather than merely passing independently of this fix.

- **timestamp:** 2026-08-06T13:17:00Z
  **checked:** Full local suite and static release-diff guards after source restoration.
  **found:** `bun test` passes 555 tests across 89 files with zero failures. `git diff --check` is clean. No `cockroach_postgres` or `ccloud` identifier occurs in the changed release source/tests. No Stryker or other mutation-test configuration exists in the repository, so mutation analysis is unavailable rather than passing by inference.
  **implication:** The fix-acceptance guardrail accepts the target/adjacent/revert/no-op signals; mutation is an explicitly documented non-applicable gap. The supported product path remains a no-effect authorization preflight.

- **timestamp:** 2026-08-06T19:05:00Z
  **checked:** Product request projection, native-discovery composition, live-cost contract, and consent descriptor source.
  **found:** `--request` directly serializes controller `priceLines` and maximum; native discovery binds every `costEstimateSha256` to the candidate and `controller-effect-plan-v1`, not a provider price source; the live estimator requires a complete 16-family available catalog but is not yet composed here; pending consent descriptors contain only `{channel, authorizationRequestSha256, expiresAtMs}`; local config produces `executionReadiness: null`.
  **implication:** The reported fixture-catalog/158 request is explained by missing production-readiness composition rather than failed native authentication. Fixing only discovery cannot make pricing, readiness, or consent launches truthful.

- **timestamp:** 2026-08-06T19:05:00Z
  **checked:** Redacted coordinator-supplied capability and pricing evidence.
  **found:** A Google ADC read-only Cloud Billing service probe succeeds, but the configured future GCP project is unavailable and must not be replaced with a different accessible project. Public GCP catalog reads are possible; current account-specific v1beta reads are not authoritative. Modal/Fly lack configured documented account-specific rate APIs.
  **implication:** An authoritative source-attribution model must block unknown/non-GCP prices and project-scope mismatch; it must not reuse an unrelated project or retain fixture price facts.

- **timestamp:** 2026-08-06T19:12:00Z
  **checked:** Agent-authored fixture-free product-request regression before the fix.
  **found:** The test failed as predicted: stdout contained `progress: authorization_required`, three generic `consentLaunches`, `executionReadiness: null`, all sixteen `*-fixture-catalog` lines, and a 158-micro maximum.
  **implication:** The reported behavior is reproduced locally without any provider command or credential. The fixture fallback and presentation semantics are directly exercised by the regression.

- **timestamp:** 2026-08-06T19:18:00Z
  **checked:** Agent-authored regression after requiring a current price catalog on the product entry path.
  **found:** `bun test tests/release/certify-release.test.ts --test-name-pattern 'product request fails closed'` passes. The request now reports `preapproval_blocked`, current-price and execution readiness blockers, and bounded operator-funding/future-owner-signature prerequisites; it prints no fixture catalog.
  **implication:** The targeted behavior is fixed. Update the previous product-output expectations before adjacent-suite verification.

- **timestamp:** 2026-08-06T19:22:00Z
  **checked:** Focused product CLI and adjacent controller/pricing/readiness suites under `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny`.
  **found:** `tests/release/certify-release.test.ts` passes 11/11. `controller`, `release-authorization-costs`, `production-readiness`, `production-execution`, `live-cost-estimator`, and `native-discovery` pass 27/27. The product path now blocks before request persistence when its current price catalog is absent, while direct controller tests retain explicitly injected fixture catalogs.
  **implication:** The change is compatible with the existing no-effect controller contracts and covers the intended product-entrypoint boundary.

- **timestamp:** 2026-08-06T19:24:00Z
  **checked:** Full local test suite with deny-effects environment.
  **found:** `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test --timeout 10000` passed 654 tests across 117 files with zero failures.
  **implication:** The fail-closed product path did not regress the broader application test suite.

- **timestamp:** 2026-08-06T19:27:00Z
  **checked:** Diff guardrail, mutation-tool availability, and temporary source revert/reapply.
  **found:** `git diff --check` is clean; the scoped diff adds an explicit guard/projection rather than deleting or bypassing behavior; no Stryker/mutation configuration is present. After stashing only `scripts/certify-release.ts`, `src/release/controller.ts`, and `src/release/deployment/consent.ts`, the agent-authored product regression failed with the former fixture-priced 158-micro request and generic consent launches. Restoring that stash re-applied exactly the scoped changes; unrelated untracked files were preserved.
  **implication:** The regression detects this fix causally. Mutation analysis is unavailable and must remain a documented skipped guardrail signal.

## Eliminated

## Resolution

- **root_cause:** The product command correctly used the previously repaired read-only native discovery registry, but it supplied no `LiveCostCatalogPort`. `ReleaseCertificationController.dryRun()` silently substituted its candidate-bound test catalog, deterministically producing the sixteen `*-fixture-catalog` lines and false 158-micro approval ceiling. The CLI then mislabeled future owner publication signing and operator wallet setup as launchable user consent, while an absent protected factory appeared as `null` readiness.
- **fix:** Require a current source-attributed catalog on the product entry path and stop at a bounded `preapproval_blocked` result when it is absent. Keep candidate fixture costs available only to direct local/test controller compositions. Report protected-factory readiness as an explicit blocked result, classify NWC/Cashu as an operator funding-rail prerequisite, and defer NIP-46 owner signing to actual napplet publication. No consent or provider effect is launched.
- **verification:**
  - target_and_adjacent: `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/certify-release.test.ts tests/release/controller.test.ts tests/release/production-readiness.test.ts --timeout 10000` — 23 passed, 0 failed
  - full_regression: `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test --timeout 10000` — 654 passed across 117 files, 0 failed, 5041 assertions
  - production_preflight: `bun scripts/certify-release.ts --candidate toolchains/candidates/initial.json --request` returns `preapproval_blocked`, explicit pricing/execution blockers, and bounded prerequisites without a review, receipt authority, generic consent launch, path, token, secret, or fixture-catalog value
  - no_op_or_deletion: passed — the diff adds a required-authority guard and finite blocker projection; `git diff --check` is clean
  - revert_and_reconfirm: passed — the focused product regression returned to the former fixture-priced 158-micro output when only the three production files were temporarily stashed, then passed after exact restoration
  - mutation: skipped — no mutation-test tool/configuration is present
  - guardrail_verdict: accepted
- **files_changed:**
  - scripts/certify-release.ts
  - src/release/controller.ts
  - src/release/deployment/consent.ts
  - tests/release/certify-release.test.ts
  - .planning/debug/release-certifier-live-path.md
- **oracle_type:** specified — an approvable request must derive from current source-attributed price facts and real deployment prerequisites; missing authority must block rather than fabricate a price or consent surface.
