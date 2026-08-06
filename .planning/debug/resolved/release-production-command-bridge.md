---
status: resolved
trigger: "Diagnose and fix the blocking product execution/configuration gap in the non-dry release certification command: it unconditionally builds an empty blocked registry and throws before any exact receipt can execute."
created: 2026-08-06T00:00:00+00:00
updated: 2026-08-06T16:10:00+00:00
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

bug_class: bohrbug
known_pattern_candidate: "07-20-discovery-registry — dry-run discovery diverged from complete provider registry"
bug_class: bohrbug
hypothesis: "Resolved bridge: the non-dry product command now loads one protected, hash-pinned deployment session and reaches the controller's exact authorization boundary."
test: "Focused no-effect regressions, two full deterministic suites, controlled revert/reapply, and final diff/static inspection."
expecting: "Local or credential-unavailable configuration remains unable to load the session; a valid deployment session must own all real external handles."
next_action: "Planned blocker: implement and deploy a protected, hash-pinned `createReleaseExecutionSession` factory with the official receipt, 16 provider ports, eight real protected ports, materialization/worker-selection, and finalization inputs. Do not run live certification from this local/evidence-only environment."

reasoning_checkpoint:
  hypothesis: "The non-dry product command is blocked because it does not possess or load the exact session object required by executeAuthorized; the unconditional empty registry/throw masks this absent composition."
  confirming_evidence:
    - "The non-dry script calls runReleaseCertification with a digest string only; controller line 620 creates createNativeReleaseProviderRegistry with no provider ports and then throws."
    - "executeAuthorized requires the exact receipt object, all-family authorized registry, materialization/worker selection, eight evidenceClass:real ports, and finalization input; the current certifier config has only local evidence settings."
  falsification_test: "A current config/loader that constructs and validates a full ReleaseExecutionSession from the one config reference, or a non-dry overload that reaches executeAuthorized without an unconditional throw, would falsify this hypothesis."
  fix_rationale: "Use the existing pinned certifier-config reference to point at one deployment-owned, hash-pinned release session factory. The controller can use its one registry for discovery and the same instance for execution; the factory alone returns an official approval-backed exact receipt and real ports. Local/no-factory configuration fails before an external call."
  blind_spots: "No deployment-owned executor module, provider profile, credentials, official approval service, or real evidence port exists in the repository, so this task cannot validate a live run and must not invent any."
  candidate_causes:
    - "code: runReleaseCertification unconditionally discards the opportunity to call executeAuthorized and constructs an empty registry."
    - "config: the sole certifier config schema has no release-session factory reference; the current local config has no provider profiles or handles."
    - "environment: no concrete authenticated external client/session is supplied for 15 families, and only Modal has a low-level SDK constructor elsewhere."
    - "data: the CLI has only a receipt digest rather than the exact structured receipt that controller validation requires."
  and_gate: "yes — real execution requires both code that accepts a same-run session and a deployment-owned session containing official consent plus all required real provider/protected ports; either missing condition independently blocks execution."

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: "A non-dry product command builds/reuses same-run controller material, composes supplied concrete provider ports, and executes only the authorized provider families; unavailable families remain explicitly fail-closed."
actual: "runReleaseCertification(non-dry) creates an empty blocked native registry and throws RELEASE_PRODUCTION_CAPABILITY_OR_CONSENT_REQUIRED, so scripts/certify-release.ts cannot execute any exact receipt."
errors: "RELEASE_PRODUCTION_CAPABILITY_OR_CONSENT_REQUIRED"
reproduction: "Run scripts/certify-release.ts with --dry-run=false and a valid exact receipt under the current config reference."
started: "Plan 07-20 through 07-39 completion claim; deterministic in the current tree."

## Eliminated
<!-- APPEND only - prevents re-investigating -->

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-08-06T00:00:00+00:00
  checked: initial reporter-provided symptom set
  found: non-dry certification is blocked by a deterministic controller branch; current config is evidence-only and lacks provider profiles/keys
  implication: inspect the exact configuration-to-provider composition path before changing code
- timestamp: 2026-08-06T14:00:00+00:00
  checked: active release-certifier session and debug knowledge base fallback
  found: a prior active session established a read-only native discovery bridge, but its resolution explicitly retains a fail-closed non-dry executor boundary; the knowledge base has a related 07-20 discovery-registry entry, not a resolution of non-dry provider composition
  implication: treat native discovery as an available precursor and independently verify whether current production-port contracts now make a smallest executable bridge possible
- timestamp: 2026-08-06T14:05:00+00:00
  checked: codebase-memory call graph for runReleaseCertification and createReleaseProviderRegistry
  found: the graph locates the release controller/registry seam and confirms the registry accepts injected ports, but its cached runReleaseCertification signature still requires dryRun:true while the current task reports a non-dry branch
  implication: graph evidence is stale for the changed release code; fall back to complete working-tree source reading before hypothesis testing
- timestamp: 2026-08-06T14:20:00+00:00
  checked: current controller, CLI, native-registry, provider registry, certifier config, and protected-port contracts
  found: scripts/certify-release.ts non-dry branch calls runReleaseCertification with only candidate/workspace/false/authorization digest; runReleaseCertification validates only digest shape, creates createNativeReleaseProviderRegistry({ candidateSha256 }) with no providers, then always throws RELEASE_PRODUCTION_CAPABILITY_OR_CONSENT_REQUIRED. executeAuthorized instead requires a complete exact receipt, authorized registry, materialization, worker selection, eight evidenceClass:real protected ports, and finalization input. The one config reference currently resolves a local evidence-only config and carries none of those inputs.
  implication: the product command has a hard composition gap, not an authorization failure; a safe bridge may only construct provider/client inputs already concretely available and must block missing required families before any effect
- timestamp: 2026-08-06T14:20:00+00:00
  checked: native registry and initial provider adapters
  found: native-registry closes all 16 families over injected ReleaseProviderPort values and blocks an absent port. Modal and Fly native adapters implement ReleaseProviderPort but require injected SDK/client/readiness ports; Cloud Run, GCS, Collector, and Cloud SQL adapters require injected control-plane ports; protected certification requires all eight real evidence ports.
  implication: no current config-to-port composition factory exists. Provider contracts alone cannot safely make the non-dry command executable.
- timestamp: 2026-08-06T14:20:00+00:00
  checked: SBFL eligibility
  found: focused release tests exist but the reported production composition branch has no failing agent-authored regression and no per-test coverage spectrum
  implication: SBFL skipped; use deterministic call-path tracing and a focused specified-contract regression test
- timestamp: 2026-08-06T14:35:00+00:00
  checked: authorization, materialization, Plan 07-37/07-38/07-39 contracts, and production-port factory map
  found: authorization receipt validation consumes a structured exact receipt, but the CLI passes only a digest. Plan 07-39 explicitly promises a product command that constructs the 07-37 registry and resumes without an unimplemented-family stop. In fact, its production registry test supplies all 16 ports and all eight real ports as fakes; native-registry has no config/client/session composition. The materialized protected config is created only after executeAuthorized begins, so it cannot bootstrap the first live call.
  implication: the Plan 07-39 completion claim is contradicted by the executable path. The smallest safe repair is a single pinned-config session-factory seam; no local configuration may cross it.
- timestamp: 2026-08-06T14:50:00+00:00
  checked: agent-authored TDD regression before and after the bridge change
  found: before implementation, the non-dry local command returned RELEASE_AUTHORIZATION_REQUIRED and protected config rejected releaseExecution as invalid. After adding the optional pinned releaseExecution config field, session loader, and same-run controller path, both focused tests pass and the local command returns RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED before provider setup.
  implication: the generic empty-registry stop is removed from the product command; the remaining missing external composition is explicit and fail-closed
- timestamp: 2026-08-06T15:05:00+00:00
  checked: no-effect session-loader regression plus focused CLI, controller, and certifier-config suites
  found: 24 tests passed. The new hash-pinned session factory regression observed only the in-memory `providers()` structural validation; no discover, plan, apply, observe, cleanup, protected-suite, network, or provider action occurred. The local configuration regression passes with `RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED`.
  implication: both the safe deployment-session boundary and local fail-closed behavior hold under the targeted executable tests
- timestamp: 2026-08-06T15:20:00+00:00
  checked: full test suite and repository-wide TypeScript check
  found: `bun test` passed all 621 tests across 105 files. `bunx tsc --noEmit` remains red with pre-existing repository-wide errors (for example `infra/toolchain/fixture-runner.ts`, `src/admission/benchmark.ts`, `src/release/authorization.ts`, and several phase-design test files); no error was reported in the changed product-command bridge files.
  implication: executable regression coverage is green; a clean whole-repository TypeScript gate is unavailable independently of this change
- timestamp: 2026-08-06T15:25:00+00:00
  checked: direct same-session controller regression
  found: 25 focused tests pass. In the new non-dry regression, the controller invoked `prepareAuthorizedExecution` with an issued digest, performed 32 fake discovery observations (two per 16 families), then rejected the deliberately invalid receipt before any fake plan, apply, observe, or cleanup call.
  implication: the replacement command path reaches the actual authorization boundary and preserves the no-mutation-before-exact-receipt invariant
- timestamp: 2026-08-06T15:30:00+00:00
  checked: full suite after the same-session regression
  found: `bun test` passed all 622 tests across 105 files with 4,985 expectations and no failures.
  implication: the added direct controller-path regression has not regressed the wider repository test suite
- timestamp: 2026-08-06T15:40:00+00:00
  checked: controlled revert/reapply of only this task's source and test paths
  found: with the bridge stashed, the local non-dry product command returned `RELEASE_AUTHORIZATION_REQUIRED`; after restoring exactly the same paths, it returned `RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED`. Neither invocation contacted a provider or created a receipt.
  implication: the observed local command behavior changes specifically because of this fix, and the restored fix retains the intended fail-closed boundary
- timestamp: 2026-08-06T15:45:00+00:00
  checked: credential-unavailable production-session regression before the final code change
  found: the new specified-oracle regression failed as expected: a protected config marked `credentials: unavailable` reached the missing module and produced `RELEASE_PRODUCTION_EXECUTION_CONFIG_INVALID`.
  implication: this would make a configuration-declared unavailable environment touch the module-loading boundary, so it must be stopped earlier
- timestamp: 2026-08-06T15:50:00+00:00
  checked: focused suites after requiring `credentials: configured` before module loading
  found: 26 focused tests pass. Local and credential-unavailable configurations both return `RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED`; the same-session invalid-receipt test still observes zero plan and mutation calls.
  implication: missing or explicitly unavailable credentials now fail before module import, provider discovery, or provider action
- timestamp: 2026-08-06T16:00:00+00:00
  checked: full suite after the credential fail-closed change
  found: `bun test` passed all 623 tests across 105 files with 4,986 expectations and no failures.
  implication: the final fail-closed refinement preserves the complete deterministic test suite
- timestamp: 2026-08-06T16:05:00+00:00
  checked: final whitespace and changed-file TypeScript diagnostic checks
  found: `git diff --check` is clean. No TypeScript diagnostic references a changed source file or the new regression file. The only matched changed-test diagnostics are pre-existing type widening at `tests/release/certify-release.test.ts:14` and `:17`, outside this change's edited lines; the repository-wide check remains independently red.
  implication: the bridge has no observed local static diagnostic, while whole-repository typecheck cannot serve as an acceptance gate

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: "The Plan 07-39 product command never invoked the completed same-run controller. `scripts/certify-release.ts` supplied only a receipt digest; `runReleaseCertification(non-dry)` created an empty all-blocked native registry and unconditionally threw `RELEASE_PRODUCTION_CAPABILITY_OR_CONSENT_REQUIRED`. The local certifier config had no release-session factory, while `executeAuthorized` requires a full exact receipt, all-family registry, exact-eight real ports, materialization inputs, and finalization input."
fix: "Added a hash-pinned single-config release-session bridge. A protected deployment config may point to one pinned factory that supplies the same-run registry and official-consent-backed execution input; the CLI uses it to call `executeAuthorized`. Local, absent, or credential-unavailable factory configuration fails with `RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED` before module loading or provider interaction."
verification: "Focused no-effect and adjacent regression suites: 26 pass, 0 fail. Full suite: 623 pass, 0 fail. Controlled revert/reapply changes the local failure from RELEASE_AUTHORIZATION_REQUIRED to RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED. Repository-wide TypeScript remains red on pre-existing unrelated errors; no changed bridge-file error reported. No mutation-test runner is configured. No external provider invocation was attempted. This resolves the product-command bridge only; live readiness remains blocked on a deployment-owned session factory with real external ports and official approval."
files_changed:
  - scripts/certify-release.ts
  - src/certification/config.ts
  - src/release/controller.ts
  - src/release/production-execution.ts
  - tests/release/certify-release.test.ts
  - tests/release/production-execution.test.ts
  - tests/phase-07/certifier-config.test.ts
