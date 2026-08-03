---
schema_version: 1
open_count: 1
waived_count: 0
fixed_count: 0
total_count: 1
last_updated: 2026-08-03T07:10:01.403Z
---

# Broken Windows Ledger

> Cross-phase defect register. `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 01 | deviation | tests/promotion/candidate.test.ts |  | Corrected invalid hexadecimal test pins and workflow-guard false positive. | open |  | 2026-08-03T07:10:01.403Z |  |

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
  }
]
````
