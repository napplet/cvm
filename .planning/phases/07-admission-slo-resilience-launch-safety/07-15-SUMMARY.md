---
phase: 07-admission-slo-resilience-launch-safety
plan: "15"
subsystem: security
tags: [reproducibility, cosign, cyclonedx, in-toto, supply-chain, content-addressed-evidence]
requires:
  - phase: 07-14
    provides: Canonical release bindings and admission compatibility closure
provides:
  - Strict two-isolation protected reproducibility verifier
  - Digest-pinned Cosign, CycloneDX, and in-toto verification foundation
affects: [07-16-release-integration, promotion, protected-certification]
tech-stack:
  added: []
  patterns: [closed-argv-pinned-tools, redacted-content-addressed-certification-records]
key-files:
  created:
    - src/certification/reproducibility.ts
    - src/certification/supply-chain.ts
    - scripts/verify-phase-07-reproducibility.ts
    - scripts/verify-phase-07-supply-chain.ts
  modified: []
key-decisions:
  - "Two protected build observations must have distinct isolation and run identities, exact release bindings, and one matching artifact digest."
  - "Cosign provides signature verification; this service only hashes the pinned executable, constructs closed argv, and parses the verified attestation payload."
  - "Persisted records contain only finite hashes and status facts, never raw identities, paths, documents, or command output."
patterns-established:
  - "Protected verification defaults to a safe blocked preflight when configuration is absent."
  - "Reviewed supply-chain documents are canonical-hashed and bound to exact lock, toolchain, dataset, candidate, and artifact inputs."
requirements-completed: [OPS-04]
coverage:
  - id: D1
    description: Strict protected two-isolation reproducibility record validation and redacted content-addressed persistence.
    requirement: OPS-04
    verification:
      - kind: unit
        ref: tests/phase-07/reproducibility.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Pinned Cosign attestation, CycloneDX 1.5 SBOM, and in-toto provenance verifier foundation.
    requirement: OPS-04
    verification:
      - kind: unit
        ref: tests/phase-07/supply-chain.test.ts
        status: pass
    human_judgment: false
metrics:
  duration: 7m 11s
  completed: 2026-08-05
  status: complete
---

# Phase 07 Plan 15: Protected Reproducibility and Supply-Chain Summary

**Fail-closed, redacted certification foundations now require two independent protected builds and digest-pinned Cosign-attested reviewed supply-chain documents.**

## Performance

- **Duration:** 7m 11s
- **Started:** 2026-08-05T20:25:04Z
- **Completed:** 2026-08-05T20:32:15Z
- **Tasks:** 2/2
- **Files modified:** 6

## Accomplishments

- Added strict two-isolation reproducibility verification with freshness, candidate, source/lock/toolchain/dataset, and exact-output fences.
- Added content-addressed records that hash run identities before persistence and reject collisions or expanded/malformed records.
- Added digest-pinned closed-argv Cosign execution plus strict CycloneDX 1.5 and in-toto/SLSA document bindings without persisting raw tool output.

## Task Commits

1. **Task 1: Verify two distinct protected isolated builds** - `2f73a0f` (test), `ff143b9` (feat)
2. **Task 2: Verify pinned Cosign, reviewed CycloneDX SBOM, and in-toto provenance** - `69da0a4` (test), `9c418ea` (feat)

## Files Created/Modified

- `src/certification/reproducibility.ts` - strict protected build aggregate schemas, verification, and immutable writer.
- `scripts/verify-phase-07-reproducibility.ts` - protected-reference-only reproducibility preflight seam.
- `tests/phase-07/reproducibility.test.ts` - two-isolation and mutation coverage.
- `src/certification/supply-chain.ts` - pinned Cosign command, reviewed SBOM/provenance validation, and immutable writer.
- `scripts/verify-phase-07-supply-chain.ts` - protected configuration preflight seam.
- `tests/phase-07/supply-chain.test.ts` - tool, identity, predicate, subject, binding, and redaction mutations.

## Decisions Made

- Use Cosign as the sole signature-verification authority; the verifier does not reimplement cryptography or accept unchecked stdout.
- Keep raw identities, documents, paths, and command output out of durable evidence; records retain only canonical digest-bound facts.
- Keep production execution blocked until the protected Cosign binary, its SHA-256, and protected build record path are configured. Plan 07-16 owns release/promotion integration.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Regression] Preserved immutable OpenTelemetry approval input identity**
- **Found during:** Task 2 full regression
- **Issue:** Adding convenience package scripts changed `package.json`, invalidating the existing approval fixture's exact root-input digest.
- **Fix:** Removed the nonessential package-script additions; the verifier scripts remain directly runnable and package approval inputs remain unchanged.
- **Files modified:** `package.json` (restored; no committed change)
- **Verification:** Focused verifier tests pass; the unrelated approval fixture is no longer affected by this plan's changes.
- **Committed in:** `9c418ea` (Task 2 implementation; no package file included)

---

**Total deviations:** 1 auto-fixed (1 regression)
**Impact on plan:** The required verifier foundations remain complete without altering an independently approved dependency graph.

## Issues Encountered

- `bun test --timeout 10000` exercised 503 tests; 501 passed. Two pre-existing OpenTelemetry delegated-approval tests still fail because their approval verifier rejects the current immutable root-input state. They are outside these verifier files and were not modified.

## User Setup Required

Protected live invocation remains intentionally blocked until the certification image provides `PHASE07_COSIGN_EXECUTABLE`, `PHASE07_COSIGN_SHA256`, and `PHASE07_BUILD_RECORDS_PATH`. Missing inputs return finite blocked output and never run a build or Cosign.

## Next Phase Readiness

Plan 07-16 can compose these strict validators into protected-runner and release-promotion flow; this plan does not add a promotion path or claim live certification.

## Known Stubs

None.

## Self-Check: PASSED

- All six plan implementation/test files exist.
- TDD RED and GREEN commits `2f73a0f`, `ff143b9`, `69da0a4`, and `9c418ea` exist.

---
*Phase: 07-admission-slo-resilience-launch-safety*
*Completed: 2026-08-05*
