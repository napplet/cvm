---
schema_version: 1
open_count: 23
waived_count: 0
fixed_count: 0
total_count: 23
last_updated: 2026-08-06T14:38:44.092Z
---

# Broken Windows Ledger

> Cross-phase defect register. `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 01 | deviation | tests/promotion/candidate.test.ts |  | Corrected invalid hexadecimal test pins and workflow-guard false positive. | open |  | 2026-08-03T07:10:01.403Z |  |
| 2 | 01 | stub | infra/toolchain/fixture-runner.ts |  | Sealed native fixture blocks until an upstream-compatible content-addressed boilerplate scaffold and browser dependencies are materialized. | open |  | 2026-08-03T20:32:25.966Z |  |
| 3 | 01 | stub | infra/toolchain/fixture-runner.ts |  | Native fixture scaffold is not self-contained under sealed --network=none; compatible scaffold and real Chromium closure deferred to Phase 7. | open |  | 2026-08-03T20:44:38.817Z |  |
| 4 | 02 | deviation | src/phase-02/contracts.ts |  | Completed named strict shared-contract exports required by the Phase 2 integration seam. | open |  | 2026-08-04T10:44:56.898Z |  |
| 5 | 02 | deviation | src/persistence/session-store.ts |  | Replay-before-effect lookup added so exact retries cannot repeat worker or gateway effects | open |  | 2026-08-04T11:25:33.325Z |  |
| 6 | 02 | deviation | src/phase-02/trusted-core.ts |  | Per-session serialization added so competing actions cannot repeat scoped worker effects | open |  | 2026-08-04T11:25:33.387Z |  |
| 7 | 05 | deviation | tests/phase-05/checkpoint-envelope.test.ts |  | Corrected checkpoint envelope test setup helper shadowing. | open |  | 2026-08-05T01:22:59.800Z |  |
| 8 | 05 | deviation | src/continuity/checkpoint-envelope.ts |  | Added strict Web Crypto BufferSource typing compatibility. | open |  | 2026-08-05T01:22:59.862Z |  |
| 9 | 05 | deviation | tests/phase-05/grace-wake.test.ts | 16 | Corrected grace-wake test account identity to use the funding principal mapping. | open |  | 2026-08-05T01:35:26.127Z |  |
| 10 | 06 | deviation | src/publication/publication-service.ts |  | Tracer implementation corrected strict preview input and SHA-256 template digest validation. | open |  | 2026-08-05T08:09:03.064Z |  |
| 11 | 07 | skipped-test | tests/phase-07/admission-slo.test.ts | 66 | Intentional pending production-observation registration owned by Plan 07-01. | open |  | 2026-08-05T15:33:50.591Z |  |
| 12 | 07 | skipped-test | tests/phase-07/telemetry-policy.test.ts | 40 | Intentional pending production-observation registration owned by Plan 07-04. | open |  | 2026-08-05T15:33:50.656Z |  |
| 13 | 07 | skipped-test | tests/phase-07/fault-matrix.test.ts | 27 | Intentional pending original-operation observation registration owned by Plans 07-06 and 07-09. | open |  | 2026-08-05T15:33:50.720Z |  |
| 14 | 07 | skipped-test | tests/phase-07/restore-drill.test.ts | 27 | Intentional pending fresh-instance restore observation registration owned by Plan 07-07. | open |  | 2026-08-05T15:33:50.781Z |  |
| 15 | 07 | skipped-test | tests/evals/phase-07-reference-set.test.ts | 29 | Intentional pending actual-authority comparator registration owned by Plans 07-06 and 07-09. | open |  | 2026-08-05T15:33:50.844Z |  |
| 16 | 07 | skipped-test | tests/phase-07/promotion-gate.test.ts | 43 | Intentional pending atomic promotion-evidence registration owned by Plan 07-10. | open |  | 2026-08-05T15:33:50.908Z |  |
| 17 | 07 | deviation | .planning/STATE.md |  | Normalized legacy Phase 7 Current Position metadata so state.advance-plan could record Plan 07-00 completion. | open |  | 2026-08-05T15:36:07.022Z |  |
| 18 | 07 | deviation | scripts/verify-phase-07-otel-packages.ts |  | Docker daemon start and smoke endpoint/batch corrections were required before the passing disposable Collector compatibility record. | open |  | 2026-08-05T16:34:49.306Z |  |
| 19 | 07 | deviation | tests/tracer.test.ts |  | Promotion tracer assertion changed to the concrete certification-required blocker after the deferred terminal stage was removed. | open |  | 2026-08-05T17:05:44.142Z |  |
| 20 | 07 | deviation | tests/contextvm/adapter.test.ts |  | ContextVM transport fake now returns a canonical SHA-256-shaped invocation hash required by strict admission validation. | open |  | 2026-08-05T20:23:59.583Z |  |
| 21 | 07 | deviation | scripts/verify-phase-07-otel-packages.ts |  | Allowed only the exact candidate-only command manifest alongside the prior approved root manifest; other input drift remains blocked. | open |  | 2026-08-06T12:14:09.784Z |  |
| 22 | 07 | deviation | scripts/certify-release.ts |  | Added an ignored controller-owned default workspace so the documented candidate-only command reaches authorization_required without environment setup. | open |  | 2026-08-06T12:18:20.750Z |  |
| 23 | 07 | deviation | .planning/phases/07-admission-slo-resilience-launch-safety/07-32-PLAN.md |  | Plan referenced renamed worker and live-admission test paths; current equivalent contracts were verified. | open |  | 2026-08-06T14:38:44.092Z |  |

````json
[
  {
    "id": 1,
    "kind": "deviation",
    "phase": "01",
    "file": "tests/promotion/candidate.test.ts",
    "line": null,
    "description": "Corrected invalid hexadecimal test pins and workflow-guard false positive.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-03T07:10:01.403Z",
    "resolved_at": null
  },
  {
    "id": 2,
    "kind": "stub",
    "phase": "01",
    "file": "infra/toolchain/fixture-runner.ts",
    "line": null,
    "description": "Sealed native fixture blocks until an upstream-compatible content-addressed boilerplate scaffold and browser dependencies are materialized.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-03T20:32:25.966Z",
    "resolved_at": null
  },
  {
    "id": 3,
    "kind": "stub",
    "phase": "01",
    "file": "infra/toolchain/fixture-runner.ts",
    "line": null,
    "description": "Native fixture scaffold is not self-contained under sealed --network=none; compatible scaffold and real Chromium closure deferred to Phase 7.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-03T20:44:38.817Z",
    "resolved_at": null
  },
  {
    "id": 4,
    "kind": "deviation",
    "phase": "02",
    "file": "src/phase-02/contracts.ts",
    "line": null,
    "description": "Completed named strict shared-contract exports required by the Phase 2 integration seam.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-04T10:44:56.898Z",
    "resolved_at": null
  },
  {
    "id": 5,
    "kind": "deviation",
    "phase": "02",
    "file": "src/persistence/session-store.ts",
    "line": null,
    "description": "Replay-before-effect lookup added so exact retries cannot repeat worker or gateway effects",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-04T11:25:33.325Z",
    "resolved_at": null
  },
  {
    "id": 6,
    "kind": "deviation",
    "phase": "02",
    "file": "src/phase-02/trusted-core.ts",
    "line": null,
    "description": "Per-session serialization added so competing actions cannot repeat scoped worker effects",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-04T11:25:33.387Z",
    "resolved_at": null
  },
  {
    "id": 7,
    "kind": "deviation",
    "phase": "05",
    "file": "tests/phase-05/checkpoint-envelope.test.ts",
    "line": null,
    "description": "Corrected checkpoint envelope test setup helper shadowing.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-05T01:22:59.800Z",
    "resolved_at": null
  },
  {
    "id": 8,
    "kind": "deviation",
    "phase": "05",
    "file": "src/continuity/checkpoint-envelope.ts",
    "line": null,
    "description": "Added strict Web Crypto BufferSource typing compatibility.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-05T01:22:59.862Z",
    "resolved_at": null
  },
  {
    "id": 9,
    "kind": "deviation",
    "phase": "05",
    "file": "tests/phase-05/grace-wake.test.ts",
    "line": 16,
    "description": "Corrected grace-wake test account identity to use the funding principal mapping.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-05T01:35:26.127Z",
    "resolved_at": null
  },
  {
    "id": 10,
    "kind": "deviation",
    "phase": "06",
    "file": "src/publication/publication-service.ts",
    "line": null,
    "description": "Tracer implementation corrected strict preview input and SHA-256 template digest validation.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-05T08:09:03.064Z",
    "resolved_at": null
  },
  {
    "id": 11,
    "kind": "skipped-test",
    "phase": "07",
    "file": "tests/phase-07/admission-slo.test.ts",
    "line": 66,
    "description": "Intentional pending production-observation registration owned by Plan 07-01.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-05T15:33:50.591Z",
    "resolved_at": null
  },
  {
    "id": 12,
    "kind": "skipped-test",
    "phase": "07",
    "file": "tests/phase-07/telemetry-policy.test.ts",
    "line": 40,
    "description": "Intentional pending production-observation registration owned by Plan 07-04.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-05T15:33:50.656Z",
    "resolved_at": null
  },
  {
    "id": 13,
    "kind": "skipped-test",
    "phase": "07",
    "file": "tests/phase-07/fault-matrix.test.ts",
    "line": 27,
    "description": "Intentional pending original-operation observation registration owned by Plans 07-06 and 07-09.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-05T15:33:50.720Z",
    "resolved_at": null
  },
  {
    "id": 14,
    "kind": "skipped-test",
    "phase": "07",
    "file": "tests/phase-07/restore-drill.test.ts",
    "line": 27,
    "description": "Intentional pending fresh-instance restore observation registration owned by Plan 07-07.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-05T15:33:50.781Z",
    "resolved_at": null
  },
  {
    "id": 15,
    "kind": "skipped-test",
    "phase": "07",
    "file": "tests/evals/phase-07-reference-set.test.ts",
    "line": 29,
    "description": "Intentional pending actual-authority comparator registration owned by Plans 07-06 and 07-09.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-05T15:33:50.844Z",
    "resolved_at": null
  },
  {
    "id": 16,
    "kind": "skipped-test",
    "phase": "07",
    "file": "tests/phase-07/promotion-gate.test.ts",
    "line": 43,
    "description": "Intentional pending atomic promotion-evidence registration owned by Plan 07-10.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-05T15:33:50.908Z",
    "resolved_at": null
  },
  {
    "id": 17,
    "kind": "deviation",
    "phase": "07",
    "file": ".planning/STATE.md",
    "line": null,
    "description": "Normalized legacy Phase 7 Current Position metadata so state.advance-plan could record Plan 07-00 completion.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-05T15:36:07.022Z",
    "resolved_at": null
  },
  {
    "id": 18,
    "kind": "deviation",
    "phase": "07",
    "file": "scripts/verify-phase-07-otel-packages.ts",
    "line": null,
    "description": "Docker daemon start and smoke endpoint/batch corrections were required before the passing disposable Collector compatibility record.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-05T16:34:49.306Z",
    "resolved_at": null
  },
  {
    "id": 19,
    "kind": "deviation",
    "phase": "07",
    "file": "tests/tracer.test.ts",
    "line": null,
    "description": "Promotion tracer assertion changed to the concrete certification-required blocker after the deferred terminal stage was removed.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-05T17:05:44.142Z",
    "resolved_at": null
  },
  {
    "id": 20,
    "kind": "deviation",
    "phase": "07",
    "file": "tests/contextvm/adapter.test.ts",
    "line": null,
    "description": "ContextVM transport fake now returns a canonical SHA-256-shaped invocation hash required by strict admission validation.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-05T20:23:59.583Z",
    "resolved_at": null
  },
  {
    "id": 21,
    "kind": "deviation",
    "phase": "07",
    "file": "scripts/verify-phase-07-otel-packages.ts",
    "line": null,
    "description": "Allowed only the exact candidate-only command manifest alongside the prior approved root manifest; other input drift remains blocked.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-06T12:14:09.784Z",
    "resolved_at": null
  },
  {
    "id": 22,
    "kind": "deviation",
    "phase": "07",
    "file": "scripts/certify-release.ts",
    "line": null,
    "description": "Added an ignored controller-owned default workspace so the documented candidate-only command reaches authorization_required without environment setup.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-06T12:18:20.750Z",
    "resolved_at": null
  },
  {
    "id": 23,
    "kind": "deviation",
    "phase": "07",
    "file": ".planning/phases/07-admission-slo-resilience-launch-safety/07-32-PLAN.md",
    "line": null,
    "description": "Plan referenced renamed worker and live-admission test paths; current equivalent contracts were verified.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-06T14:38:44.092Z",
    "resolved_at": null
  }
]
````
