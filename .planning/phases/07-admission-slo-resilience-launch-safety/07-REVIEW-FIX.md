---
phase: 07-admission-slo-resilience-launch-safety
fixed_at: 2026-08-05T17:32:24Z
review_path: .planning/phases/07-admission-slo-resilience-launch-safety/07-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 7
skipped: 0
status: all_fixed
---

# Phase 07: Code Review Fix Report

**Fixed at:** 2026-08-05T17:32:24Z
**Source review:** `.planning/phases/07-admission-slo-resilience-launch-safety/07-REVIEW.md`
**Iteration:** 1

**Summary:**

- Findings in scope: 7
- Fixed: 7
- Skipped: 0

## Fixed Issues

### CR-01: Receipt-bound exact readiness is required

**Commits:** `6bb36f4`, `12ab1a7`, `ef1a57d`

Available capacity requires an exact ready proof plus receipt lifecycle context; absence is compensated with no funded hold. All legacy accepting fixtures now pass the same explicit receipt context and provider-bound intent/lease proof. The Phase 07 evidence record was refreshed against the clean migration commit.

### CR-02: Release evidence has a closed inventory and immutable binding

**Commit:** `2c51466`

Promotion accepts only the fixed v1 claim inventory. Protected-live evidence is explicitly typed and bound to release ID, source revision, all immutable release inputs, and the candidate worker digest.

### CR-03: Publication observers cannot affect original effects

**Commit:** `1cf5685`

Observer exceptions are contained. Claim, record, and reconciliation callbacks cannot interrupt sibling original operations; unknown effects still reconcile by their original operation ID.

### CR-04: Collector smoke uses an immutable approved digest

**Commit:** `2521f6b`

The smoke now executes `otel/opentelemetry-collector@sha256:6ed874ea083d67a3085acfc75343f2ad11d9abe6006d7ea4a16e2dba9af14e49`. Root pin verification requires a matching passed smoke record; refreshed record: `6d124561d5b61ed453cc2bf1b8bc4cb39c1134da380c3c247a151655aaf6d93e`.

### WR-01: Lifecycle vocabulary is closed across coordinator/exporter contracts

**Commit:** `955a621`

Coordinator and redaction/exporter contracts now use one finite stage/outcome set, including generation, settlement, continuity, validation, preview, publication, reconciliation, and promotion.

### WR-02: Reference evaluation invokes deterministic project ports

**Commit:** `2dbe099`

Reference cases invoke admission and fault-harness ports with comparator-only oracles rather than deriving observations directly from fixture values.

### WR-03: Evidence source revisions are clean immutable commits

**Commits:** `6f40657`, `ef2dd82`, `4af8758`, `ef1a57d`

Evidence writing resolves a clean `HEAD` commit and verifies it is a repository object. Forged source evidence was replaced with the current content-addressed deterministic record.

## Verification

- Targeted migration tests passed: 64 tests across eight affected suites.
- Full suite passed: `bun test` — 473 passing tests, 0 failures.
- `bun run eval:phase07` passed: 64 deterministic cases, with promotion safely `blocked`.
- `bun run verify:phase07-evidence` passed and wrote source-bound evidence `c757581d136c1bae472f6dbb5b58ea6a8e59c22a1deff771bfc7c70bee149b94` for source revision `12ab1a7f8dcc260653dd8f41e586d18512fe26e1`.

---

_Fixed: 2026-08-05T17:32:24Z_
_Fixer: the agent (gsd-code-fixer)_
_Iteration: 1_
