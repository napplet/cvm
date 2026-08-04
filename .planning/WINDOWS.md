---
schema_version: 1
open_count: 4
waived_count: 0
fixed_count: 0
total_count: 4
last_updated: 2026-08-04T10:44:56.898Z
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
  }
]
````
