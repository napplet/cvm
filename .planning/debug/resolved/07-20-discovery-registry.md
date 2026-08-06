---
status: resolved
trigger: "Diagnose and fix the Plan 07-20 authenticated discovery/runtime registry disconnect. The no-effect release-certify dry run persists unsupported/unavailable/zero-account scopes for ten implemented provider IDs (contextvm, cep8_lightning, cashu, model, compatible_host, signer, promoted_cli, upload, owner_relay, attestation_relay), while only GCP, Modal, and Fly families are discovered."
created: 2026-08-06T16:40:46Z
updated: 2026-08-06T17:06:00Z
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: "Confirmed: the legacy six-provider dry-run registry diverged from the all-16-family production composition and created unsupported zero-metadata observations for implemented providers."
test: "Independent no-effect verification regenerated the original release-certify state and inspected all sixteen persisted capability/scope facts."
expecting: "Confirmed: all 16 are finite/nonzero and non-unsupported; authenticated hashes are preserved and external profiles remain explicit authorization blocks."
next_action: "Resolved and archived."
bug_class: Bohrbug
known_pattern_candidate: none
candidate_causes:
  - "code: the legacy six-entry discovery map and `unimplemented()` fallback were not replaced when 07-37 introduced the 16-family composition."
  - "config: the dry-run factory receives no candidate digest, so it cannot produce a candidate-bound controller/profile scope for a locally derived provider."
  - "environment: absent local CLIs/official sessions can make a supported provider unavailable, but cannot explain a static UNSUPPORTED_CAPABILITY observation."
  - "data: the candidate is a review-ready toolchain artifact and has no hand-authored provider account profiles; discovery must not invent identities from it."
and_gate: "yes — the stale map causes the unsupported result, and the absent candidate binding prevents the correct local/controller-derived nonzero fallback metadata."
reasoning_checkpoint:
  hypothesis: "The static six-provider NATIVE_PROBES map causes the dry-run registry to classify all ten later implemented provider families as unsupported; because it receives no candidate digest, it also cannot emit an honest nonzero candidate-bound required-scope/cost binding for an unconfigured family."
  confirming_evidence:
    - "src/release/native-discovery.ts has six map entries and routes every other ReleaseProviderId through unimplemented(), which hard-codes UNSUPPORTED_CAPABILITY and both all-zero digests."
    - "tests/release/live-production-composition.test.ts proves native production composition has all 16 provider IDs and an absent injected model port blocks through AUTHORIZATION_REQUIRED rather than an unimplemented-family fallback."
    - "The agent-authored all-family regression is RED at the zero account scope assertion for an omitted provider under injected read-only discovery."
  falsification_test: "If, before any code change, every omitted provider produced a nonzero candidate-bound scope and a non-UNSUPPORTED result, or if production composition lacked the same provider, the stale discovery-map mechanism would be wrong."
  fix_rationale: "One immutable 16-family discovery profile set removes the obsolete fallback; candidate-bound descriptor hashes are emitted only when no verified external account hash exists, while authorized native probes retain their actual redacted account hash. This changes only preflight facts, never provider execution."
  blind_spots: "The local candidate cannot attest a real external account, and this change must not claim it does. A later protected execution still needs the actual official provider login/consent or injected capability session for each blocked family."
  candidate_causes:
    - "code: stale discovery map diverges from the 16-family production composition."
    - "config: dry-run factory lacks the controller's canonical candidate digest for a safe required-scope fallback."
    - "environment: missing local CLIs/sessions can be reported as unavailable/not configured but cannot produce the static unsupported fallback."
    - "data: the review candidate contains no provider identity, so only candidate-bound required-scope descriptors—not fabricated identities—are valid absent a probe."
  and_gate: "yes — both the stale map and missing candidate-binding input must be corrected to make a generated authorization request complete and refreshable."

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: "No-effect candidate-bound discovery covers all 16 implemented provider families with nonzero/redacted scope digests and finite cost facts, or an actionable official-consent/capability-selection block where local/controller evidence cannot establish authorized access."
actual: "release:certify --dry-run persists unsupported/unavailable/zero-account scopes for contextvm, cep8_lightning, cashu, model, compatible_host, signer, promoted_cli, upload, owner_relay, and attestation_relay; only GCP, Modal, and Fly families are discovered."
errors: "UNSUPPORTED_CAPABILITY or unavailable discovery / zero-account scope for implemented provider families; generated v2 request is non-actionable and unsafe to approve."
reproduction: "bun run release:certify -- --candidate toolchains/candidates/initial.json --dry-run"
started: "After Plans 07-27 through 07-39; Plan 07-37 added the complete native/provider composition and removed unimplemented branches."

## Eliminated
<!-- APPEND only - prevents re-investigating -->


## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-08-06T16:40:46Z
  checked: "Active debug sessions and repository status"
  found: "No active debug session exists. The worktree contains unrelated untracked research cache, evidence, and deno.lock files."
  implication: "A new session is required; unrelated files must remain untouched."

- timestamp: 2026-08-06T16:46:00Z
  checked: "Knowledge base semantic fallback and release/debug history"
  found: "No prior resolved entry matches provider discovery/unsupported capability; the recent release status entries concern CLI parsing, not registry composition."
  implication: "There is no reusable diagnosis; investigate the current discovery bridge independently."

- timestamp: 2026-08-06T16:47:00Z
  checked: "src/release/native-discovery.ts, src/release/native-registry.ts, provider contracts, Plan 07-37 summary, and focused tests"
  found: "native-discovery has exactly six NATIVE_PROBES (four GCP, Modal, Fly) and maps every other RELEASE_PROVIDER_IDS member through `unimplemented()` to UNSUPPORTED_CAPABILITY with zero hashes. Native production composition instead enumerates all 16 IDs and blocks absent injected capabilities as AUTHORIZATION_REQUIRED."
  implication: "This is a deterministic dual-source-of-truth/state-management defect at the discovery-to-runtime registry bridge, not an actual external authentication result."

- timestamp: 2026-08-06T16:47:30Z
  checked: "Plan 07-27 coverage matrix and Plan 07-37 contract"
  found: "Every one of the 16 IDs is marked INTEGRATE; controller-owned configuration and topology must be derived, and absence must be `blocked`, with the user supplying only official login/consent plus exact digest approval. Plan 07-37 explicitly requires all 16 to resolve or provide explicit capability/auth blocked evidence."
  implication: "An implemented family must never be described as unsupported merely because no authenticated session is supplied to dry-run discovery."

- timestamp: 2026-08-06T16:49:00Z
  checked: "bun test tests/release/native-discovery.test.ts tests/release/live-production-composition.test.ts --timeout 10000"
  found: "All eight pre-existing focused tests pass. Native discovery's historical test explicitly expects contextvm to be unsupported/zero; production composition explicitly expects an absent injected model capability to block through AUTHORIZATION_REQUIRED."
  implication: "The suites prove the two registry paths disagree deterministically, independent of ambient provider environment."

- timestamp: 2026-08-06T16:50:00Z
  checked: "Agent-authored all-family injected discovery regression"
  found: "RED: `every implemented family has candidate-bound finite discovery metadata without a provider effect` fails because an omitted family returns the all-zero account scope. The request-regeneration control passes when an injected Modal authentication fact changes."
  implication: "The failure is reproducible with no CLI, network, credential, or provider operation; only the missing profiles need to be repaired."

- timestamp: 2026-08-06T16:55:00Z
  checked: "Focused native discovery, CLI, provider-discovery, and production-composition tests with PATH-disabled product CLI coverage"
  found: "22 tests pass. The persisted v2 authorization request contains all 16 nonzero account/project scope digests; all implemented families are non-unsupported. The injected authorized Google, Modal, and Fly probes retain their original redacted account hashes, while only their candidate-bound cost digest changes."
  implication: "The repaired bridge is candidate-bound without fabricating an account identity or weakening the existing native redaction boundary."

- timestamp: 2026-08-06T16:56:00Z
  checked: "bunx tsc --noEmit"
  found: "The repository-wide typecheck fails on numerous pre-existing files outside this change (for example BufferSource generic mismatches, missing pg declaration, and existing release authorization/finalization errors); no error references the owned discovery bridge or focused tests."
  implication: "Repository-wide TypeScript compilation is currently not a usable acceptance gate for this scoped fix; Bun execution and focused suites remain applicable."

- timestamp: 2026-08-06T16:59:00Z
  checked: "bun test --timeout 10000"
  found: "619 tests passed, 0 failed across 104 files."
  implication: "The complete existing regression suite remains compatible with the discovery bridge change."

- timestamp: 2026-08-06T17:01:00Z
  checked: "Source-only stash/revert of scripts/certify-release.ts, src/release/controller.ts, and src/release/native-discovery.ts, retaining agent-authored tests"
  found: "The all-family regression returned RED at the old all-zero account scope for an omitted provider. After popping the exact stash, the same test returned GREEN (6 pass)."
  implication: "The minimal bridge changes, rather than an unrelated worktree condition, cause the corrected discovery behavior."

- timestamp: 2026-08-06T17:02:00Z
  checked: "Diff structure and mutation-tool availability"
  found: "git diff --check passes. The implementation replaces a 24-line unsupported fallback with explicit profiles and metadata, rather than deleting/short-circuiting behavior. No Stryker configuration or dependency exists in this repository."
  implication: "The no-op/deletion detector passes; mutation testing is explicitly unavailable rather than treated as a pass."

- timestamp: 2026-08-06T17:06:00Z
  checked: "Independent no-effect release-certify verification after the human-verify checkpoint"
  found: "The regenerated state has all 16 capabilities available with finite nonzero account/cost scope digests and no UNSUPPORTED_CAPABILITY. Google/Modal/Fly hashes are preserved, promoted_cli is authorized, and the remaining nine external profiles are explicit AUTHORIZATION_REQUIRED blocks."
  implication: "The original workflow is resolved without provider mutations, credential disclosure, or a fabricated external identity."

- timestamp: 2026-08-06T17:06:30Z
  checked: "MemPalace resolved-session indexing"
  found: "The mempalace CLI is not installed in this environment."
  implication: "Skipped semantic indexing; the committed knowledge-base entry remains the durable recall record."

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: "`createNativeReleaseDiscoveryRegistry` remained a legacy six-provider map after Plan 07-37 introduced the full 16-provider native composition. Its `unimplemented()` fallback converts every omitted implemented family into UNSUPPORTED_CAPABILITY with zero account/cost digests. The factory is also invoked without the controller's canonical candidate digest, so it cannot emit a candidate-bound required-scope/cost descriptor for an unconfigured session."
fix: "Replaced the unimplemented fallback with immutable profiles for every integrated family. Unconfigured external families now return explicit AUTHORIZATION_REQUIRED metadata bound to the canonical candidate; candidate-local promoted_cli is configured without external authentication; existing native probes keep verified Google/Modal/Fly account hashes. release:certify now computes the controller's canonical candidate SHA and uses this registry for dry-run, request, and receipt paths."
oracle_type: "specified — all integrated provider families must emit nonzero redacted scope/cost facts or an actionable block, never UNSUPPORTED_CAPABILITY; a changed discovery fact must issue a new authorization request."
verification:
  target_test:
    result: pass
    suite: "bun test tests/release/native-discovery.test.ts --timeout 10000"
    result_summary: "6 pass; exact all-family candidate-bound discovery regression green."
  mutation_check:
    result: skipped
    reason_if_skipped: "No Stryker configuration or dependency is present."
    mutant_killed: null
  no_op_deletion:
    result: pass
    deletion_justified_by_rca: false
    evidence: "git diff --check passes; the obsolete fallback is replaced by explicit profiles and candidate-bound metadata."
  adjacent_tests:
    result: pass
    suites_run:
      - "bun test tests/release/native-discovery.test.ts tests/release/certify-release.test.ts tests/release/provider-discovery.test.ts tests/release/live-production-composition.test.ts --timeout 10000 (22 pass)"
      - "bun test --timeout 10000 (619 pass)"
  revert_and_reconfirm:
    result: pass
    bug_returned_on_revert: true
    fixed_on_reapply: true
    evidence: "Source-only stash/revert failed the all-family regression at the legacy zero scope; exact reapply restored 6 passing native-discovery tests."
  guardrail_verdict: accepted
  independent_human_verification:
    result: pass
    summary: "No-effect generated state has 16 finite, non-unsupported capabilities; authentic hashes and explicit external authorization blocks are correct."
files_changed:
  - "src/release/native-discovery.ts"
  - "src/release/controller.ts"
  - "scripts/certify-release.ts"
  - "tests/release/native-discovery.test.ts"
  - "tests/release/certify-release.test.ts"

## Prevention

- **Code branch:** The dry-run registry held a separate six-provider inventory while the later production composition owned all sixteen. There was no shared/complete discovery-profile assertion, so a newly composed family could remain on the legacy fallback.
- **Configuration/data branch:** The discovery factory was invoked without the controller's canonical candidate digest. An unconfigured provider therefore had no safe way to emit a required-scope binding and was represented by zero metadata instead.
- **Environment branch:** Missing local CLIs or official sessions are expected deployment conditions, but the old fallback made them indistinguishable from a product capability that had never been implemented.
- **Why not caught:** Existing native-discovery coverage asserted that unimplemented families should be unsupported/zero, while production-composition coverage separately asserted all sixteen families. No end-to-end dry-run assertion compared the persisted authorization request against the complete composition.
- **Recurrence guard:** `tests/release/native-discovery.test.ts` now exercises every `RELEASE_PROVIDER_IDS` member under injected read-only discovery, asserts candidate-bound nonzero metadata and no unsupported result, preserves authenticated Google/Modal/Fly hashes, and proves request regeneration. `tests/release/certify-release.test.ts` inspects the persisted v2 request's sixteen nonzero account/project scopes under the PATH-disabled no-effect command.
