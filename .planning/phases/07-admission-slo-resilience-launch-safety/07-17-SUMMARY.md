---
phase: 07-admission-slo-resilience-launch-safety
plan: "17"
subsystem: security
tags: [supply-chain, cosign, sbom, reproducibility, promotion]
requires:
  - phase: 07-16
    provides: Explicit content-addressed protected verification records and a sole release evaluator
provides:
  - Independent exact source SHA-256 binding for protected build and release evidence
  - Manifest-owned Cosign and CycloneDX trust policy revalidated at certification and promotion boundaries
affects: [protected-certification, promotion, release-evidence]
tech-stack:
  added: []
  patterns: [independent-source-byte-binding, manifest-owned-supply-chain-policy]
key-files:
  created: []
  modified:
    - src/certification/contracts.ts
    - src/certification/reproducibility.ts
    - src/certification/supply-chain.ts
    - src/certification/runner.ts
    - src/promotion/schema.ts
    - src/promotion/run-promotion.ts
    - scripts/certify-phase-07.ts
    - tests/phase-07/reproducibility.test.ts
    - tests/phase-07/supply-chain.test.ts
    - tests/phase-07/certification-runner.test.ts
    - tests/phase-07/promotion-gate.test.ts
key-decisions:
  - "Git source revision and source-byte SHA-256 are separate exact release inputs; no prefix relationship is accepted."
  - "The release manifest supplies the only Cosign signer, issuer, executable-digest, predicate, and SBOM-generator policy used for verification."
patterns-established:
  - "Persisted redacted verification records retain policy-relevant hashes and finite SBOM facts for later independent revalidation."
  - "Protected runners and the sole evaluator refuse mismatched candidate source bytes or supply-chain policy before release authority is granted."
requirements-completed: [OPS-04]
coverage:
  - id: D1
    description: "Protected reproducibility binds two independent builds to an exact source-byte SHA-256, separately from the Git revision."
    requirement: OPS-04
    verification:
      - kind: integration
        ref: tests/phase-07/reproducibility.test.ts#source revision and source bytes are independent exact release inputs
        status: pass
    human_judgment: false
  - id: D2
    description: "Cosign and SBOM facts are accepted only when they match the manifest-owned policy through verifier, runner, and promotion revalidation."
    requirement: OPS-04
    verification:
      - kind: integration
        ref: tests/phase-07/supply-chain.test.ts#manifest-owned Cosign and SBOM policy rejects self-selected identities and freshly rehashed records
        status: pass
      - kind: integration
        ref: tests/phase-07/certification-runner.test.ts#runner rejects a freshly rehashed supply record that self-selects a signer before adapter invocation
        status: pass
      - kind: integration
        ref: tests/phase-07/promotion-gate.test.ts#the sole evaluator rejects verification records bound to a self-selected manifest signer policy
        status: pass
    human_judgment: false
metrics:
  duration: 6m 28s
  completed: 2026-08-05
  status: complete
---

# Phase 07 Plan 17: Independent Source and Supply-Chain Trust Summary

**Protected release certification now requires exact independently supplied source bytes and manifest-owned Cosign/SBOM policy, closing self-attested source and signer paths.**

## Performance

- **Duration:** 6m 28s
- **Started:** 2026-08-05T20:58:41Z
- **Completed:** 2026-08-05T21:05:09Z
- **Tasks:** 2/2
- **Files modified:** 11

## Accomplishments

- Added an exact source SHA-256 alongside the Git revision to release bindings, protected profiles, reproducibility checks, and the sole promotion evaluator.
- Replaced source-prefix acceptance with exact source-byte equality for both protected builds and observed release candidates.
- Added one strict manifest-owned policy for Cosign executable digest, signer identity, OIDC issuer, predicate type, CycloneDX format/spec, and generator identity/version.
- Revalidated those policy facts from persisted redacted records before protected adapter execution and promotion; self-selected, freshly rehashed records fail closed.

## Task Commits

1. **Task 1: Bind reproducibility to an independent exact source digest** - `1738e81` (test), `cbe6ddb` (feat)
2. **Task 2: Bind Cosign and SBOM facts to independent manifest policy** - `d68f953` (test), `ce02c23` (feat)

## Files Created/Modified

- `src/certification/contracts.ts` - Defines the strict release source and supply-chain-policy binding.
- `src/certification/reproducibility.ts` - Enforces exact protected build source-byte equality.
- `src/certification/supply-chain.ts` - Compares invocation, decoded evidence, and persisted facts to independent policy.
- `src/certification/runner.ts` - Blocks protected observations before adapter authority when bindings disagree.
- `src/promotion/schema.ts` and `src/promotion/run-promotion.ts` - Parse policy as immutable manifest input and revalidate it in the sole evaluator.
- `scripts/certify-phase-07.ts` - Fails profile parsing closed when the candidate source and strict release binding disagree.
- `tests/phase-07/reproducibility.test.ts`, `tests/phase-07/supply-chain.test.ts`, `tests/phase-07/certification-runner.test.ts`, and `tests/phase-07/promotion-gate.test.ts` - Cover source-prefix, self-selected signer, record substitution, and promotion-bypass mutations.

## Decisions Made

- Source revision identifies the Git commit; the independent SHA-256 identifies exact source bytes and cannot be inferred from the revision.
- A verification record contains only redacted policy-relevant hashes/facts, but authority always comes from the separately trusted manifest policy.

## Verification

- Focused: `bun test tests/phase-07/reproducibility.test.ts tests/phase-07/supply-chain.test.ts tests/phase-07/certification-runner.test.ts tests/phase-07/promotion-gate.test.ts --timeout 10000` — 28 passed.
- Full regression: `bun test --timeout 10000` — 512 passed, 0 failed.
- `bun run certify:phase07 -- --profile=release --preflight-only` — correctly blocked without protected evidence.
- `bun run candidate:verify -- --release-evidence evidence/design/phase-07.json` — correctly blocked for non-release input.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - protected live execution remains intentionally blocked until trusted release inputs, records, adapter, and credentials are provided.

## Next Phase Readiness

Both local Phase 7 self-attestation gaps are closed. Actual protected-live certification remains external and is still required before any production promotion.

## Known Stubs

None.

## Self-Check: PASSED

- All eleven modified implementation/test files and this SUMMARY exist.
- TDD RED/GREEN commits `1738e81`, `cbe6ddb`, `d68f953`, and `ce02c23` exist.
- Focused and full automated suites passed; protected commands remained correctly fail-closed.
