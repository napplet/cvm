---
schema_version: 1
open_count: 8
waived_count: 0
fixed_count: 0
total_count: 8
last_updated: 2026-08-05T01:22:59.862Z
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
  }
]
````
