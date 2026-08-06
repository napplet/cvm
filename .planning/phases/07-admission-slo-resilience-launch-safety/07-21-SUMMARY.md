---
phase: 07-admission-slo-resilience-launch-safety
plan: "21"
subsystem: release-provisioning
tags: [typescript, zod, provider-registry, authorization, idempotency, topology]
requires:
  - phase: 07-19
    provides: candidate-bound authorization requests and resumable release controller state
provides:
  - closed project-owned registry for all release provider and integration owners
  - receipt-, effect-, operation-, and cost-bound local provisioning transitions
  - exact conservative deployed-topology observations with D-123 limitations
affects: [07-20-authorization, 07-25-protected-live-certification, release-promotion]
tech-stack:
  added: []
  patterns: [injected non-network provider ports, persist-before-effect operation records, observe-only ambiguity recovery]
key-files:
  created: [src/release/providers.ts, tests/release/provider-discovery.test.ts]
  modified: [src/release/contracts.ts, src/release/controller.ts, tests/release/controller.test.ts]
key-decisions:
  - "Provider clients are injected only; local controller tests cannot authenticate, call a live provider, or write protected evidence."
  - "Each resource operation is persisted before invocation and an unknown outcome resumes through its original operation identity only."
  - "Deployed topology records explicitly limit continuity claims until protected live drills certify their failure domains."
patterns-established:
  - "Release provider mutations require a current receipt whose candidate, request, and approved maximum exactly match the operation."
  - "Provider-native fields are strict-parsed and reduced to finite status, digest, and secret-reference facts before controller use."
requirements-completed: []
coverage:
  - id: D1
    description: Closed authorization-bound provider registry with redaction, bounded spend, and original-operation observation.
    verification:
      - kind: unit
        ref: tests/release/provider-discovery.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Resumable local topology controller that does not duplicate provider effects or widen availability claims.
    verification:
      - kind: integration
        ref: tests/release/controller.test.ts
        status: pass
    human_judgment: false
metrics:
  duration: 7m 16s
  completed: 2026-08-06
status: complete
---

# Phase 07 Plan 21: Authorized Provider Topology Summary

**A local-only provider registry and controller now bind every planned release effect to an exact receipt, stable operation identity, spend ceiling, and conservative deployed-topology record.**

## Performance

- **Duration:** 7m 16s
- **Started:** 2026-08-06T11:18:51Z
- **Completed:** 2026-08-06T11:26:07Z
- **Tasks:** 2/2
- **Files modified:** 5

## Accomplishments

- Added a closed registry covering Cloud Run, GCS, Collector, Cockroach/PostgreSQL, Modal, Fly, and all ten integration owners through injected ports only.
- Enforced receipt freshness, candidate/request/effect binding, allowed effect ownership, provider-output redaction, immutable resource identity hashes, and cost ceilings.
- Added persist-before-effect operations with observe-only ambiguity recovery and an exact 16-resource topology record that states active routing, failure domains, RTO/RPO, and explicit D-123 limits.
- Verified all paths with non-authoritative in-memory ports; zero protected-evidence writes are asserted and no live client is constructed or invoked.

## Task Commits

1. **Task 1: Implement the concrete provider capability and provisioning registry** — `3850354` (RED test), `dec437e` (implementation)
2. **Task 2: Resume provisioning into one exact discovered-topology record** — `5d64fa9` (RED test), `e1459c7` (implementation), `1f51c65` (concurrent writer fix)

## Files Created/Modified

- `src/release/providers.ts` — closed receipt-bound provider registry and finite redacted port results.
- `src/release/controller.ts` — resumable provisioning, original-operation observation, and topology assembly.
- `src/release/contracts.ts` — deployed-resource and explicit availability-limit schemas.
- `tests/release/provider-discovery.test.ts` — injected provider authorization, redaction, cost, and ambiguity contracts.
- `tests/release/controller.test.ts` — topology resume and no-protected-evidence-write coverage.

## Decisions Made

- Protected credentials and provider construction remain outside this plan: Plan 07-25 is the only authorized live caller after Plan 07-20.
- Unknown provider effects are recovered with `observe(operationId)`; the controller never creates a replacement operation.
- The topology says active-active ingress only and explicitly does not claim certified database, object-store, or worker continuity.

## Verification

- `bun test tests/release/controller.test.ts tests/release/provider-discovery.test.ts --timeout 10000` — 10 pass, 0 fail.
- `bun test --timeout 10000` — 532 pass, 0 fail.
- The requested focused provision/discover/resume/ambiguity/topology/cost command passed before the final full relevant suite.
- `bunx tsc --noEmit` still reports pre-existing unrelated repository errors; the release-only filter initially exposed and this plan corrected a legacy impossible comparison in `tests/release/controller.test.ts`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical contract] Added deployed-resource and D-123 limitation fields to the release contract**
- **Found during:** Task 2
- **Issue:** The pre-existing topology schema could only describe desired topology, so it could not safely persist provider-discovered identities, operation records, or exact availability limitations.
- **Fix:** Added strict deployed-resource, routing, failure-domain, RTO/RPO, and limitation contracts used by the controller.
- **Files modified:** `src/release/contracts.ts`, `src/release/controller.ts`
- **Verification:** Focused controller/provider suite passes.
- **Committed in:** `e1459c7`

**2. [Rule 1 - Test correctness] Scoped a legacy no-promotion assertion to terminal status**
- **Found during:** Task 2
- **Issue:** The prior broad string check rejected the required `promoted_cli` provider identifier, despite no promoted status being produced.
- **Fix:** Asserted the forbidden terminal status token instead of a legitimate provider name.
- **Files modified:** `tests/release/controller.test.ts`
- **Verification:** Full relevant suite passes.
- **Committed in:** `e1459c7`

**3. [Rule 1 - Concurrent write race] Published immutable controller files only after complete writes**
- **Found during:** Post-wave integration gate
- **Issue:** A concurrent controller could observe an exclusively created state file before its writer completed, causing a spurious `RELEASE_CONTROLLER_STATE_COLLISION`.
- **Fix:** Write a unique temporary file completely, then atomically hard-link it into the immutable final path; competing writers compare only completed file contents. Expanded concurrent controller coverage from two to eight writers.
- **Files modified:** `src/release/controller.ts`, `tests/release/controller.test.ts`
- **Verification:** Exact regression test passed 30 consecutive times; full suite passed 532 tests.
- **Committed in:** `1f51c65`

---

**Total deviations:** 3 auto-fixed (Rule 1: 2, Rule 2: 1).
**Impact on plan:** Required for exact topology integrity and compatibility with the expanded provider inventory; no live authority or scope expansion was introduced.

## Known Stubs

None. Unconfigured or unavailable providers remain explicit finite blocked facts, not rendered placeholder values.

## Issues Encountered

The repository-wide TypeScript check has pre-existing errors outside release files. The focused Bun suites are fully green; no unrelated fixes were made.

## User Setup Required

None. This plan deliberately performs local contract testing only and requests no credentials.

## Next Phase Readiness

Plan 07-20 can now request one exact, receipt-bound provider authorization. Plan 07-25 may later inject authenticated clients and execute the same persisted operation path; this plan made no provider mutation or protected evidence write.

## Self-Check: PASSED

- All five planned source/test artifacts exist, plus the critical release contract extension.
- Task commits `3850354`, `dec437e`, `5d64fa9`, and `e1459c7` are reachable in git history.

---
*Phase: 07-admission-slo-resilience-launch-safety*
*Completed: 2026-08-06*
