---
phase: 02-trusted-core-isolated-agent-execution
reviewed: 2026-08-04T15:09:39Z
depth: deep
re_review: 7
reviewed_through: fe54d02
files_reviewed: 30
files_reviewed_list:
  - package.json
  - scripts/probe-modal-worker.ts
  - scripts/verify-phase-02-design-slice.ts
  - src/admission/admission-policy.ts
  - src/admission/risk-policy.ts
  - src/capabilities/scoped-tool-gateway.ts
  - src/domain/session-action.ts
  - src/domain/session-service.ts
  - src/persistence/session-store.ts
  - src/persistence/sqlite-session-store.ts
  - src/phase-02/contracts.ts
  - src/phase-02/trusted-core.ts
  - src/policy/phase-02-policy.ts
  - src/verification/phase-02-design-evidence.ts
  - src/worker-adapters/modal-worker.ts
  - src/worker-port/fake-worker.ts
  - tests/admission/admission-policy.test.ts
  - tests/admission/risk-policy.test.ts
  - tests/capabilities/scoped-tool-gateway.test.ts
  - tests/domain/session-service.test.ts
  - tests/evals/phase-02-reference-set.test.ts
  - tests/fixtures/phase-02-reference-set.json
  - tests/integration/modal-probe.test.ts
  - tests/persistence/session-store.test.ts
  - tests/persistence/sqlite-session-store.test.ts
  - tests/phase-02/tracer.test.ts
  - tests/verification/phase-02-design-slice.test.ts
  - tests/worker-port/contracts.test.ts
  - evidence/phase-02/modal-probe.json
  - evidence/design/phase-02.json
findings:
  critical: 0
  warning: 0
  info: 0
  total: 0
status: clean
---

# Phase 02: Code Review Re-review Report

**Reviewed:** 2026-08-04T15:09:39Z
**Depth:** deep
**Reviewed through:** `fe54d02`
**Files Reviewed:** 30
**Status:** clean

## Summary

The direct cross-principal, turn-bound, checkpoint-binding, Modal request-delivery, design-evidence, normal multi-core lease, forged-artifact, and durable-effect cases are covered by the submitted fixes. `fe54d02` binds every effect intent to its creating worker-lease token: replacement attempts cannot reuse a completed predecessor intent or create a fresh call, while one unchanged attempt can still complete multiple ordered tool calls. Legacy SQLite intent rows have no token and deliberately fail closed. No critical or warning findings remain.

Verdict: **PASS — no remaining blocker identified in the reviewed scope.**

## Historical Resolution Trace

The prior findings were re-executed or inspected through `fe54d02`:

- **Former CR-01 resolved for a wrong principal:** `SessionStore.preflight()` now rejects a mismatched principal before worker allocation or dispatch.
- **Former CR-02 resolved:** completed result events are non-empty, ordered, and bounded by the canonical `maxTurns` schema.
- **Former CR-04 resolved:** checkpoint acceptance now binds the archive, inventory, export event, checkpoint event, and event-evidence digest.
- **Former WR-01 resolved:** the Modal candidate copies the canonical request to a fixed sandbox path and parses a canonical result. Its blocked/unselected status remains expected without credentials.
- **Former WR-02 resolved:** the design-slice script hashes each named check's scoped paths and verifies the immutable provider record addressed by the mutable pointer.
- **Former CR-05 directly addressed:** a SQLite `worker_leases` row is claimed before worker allocation, and the two-core/shared-database barrier regression now permits one worker and one tool effect under the normal lease lifetime.
- **Former CR-06 directly addressed:** production composition fails closed without an `ArtifactVerifier`; a verifier-owned accepted artifact carries the artifact and verification digests into durable action evidence and the action fingerprint. A worker's all-pass proposal cannot by itself reach dispatch or commit.
- **Former CR-08 resolved for an exact retry:** an effect that throws is durably marked `uncertain`; an exact retry receives `TOOL_EFFECT_UNCERTAIN`, makes no new dispatcher call, and leaves the session at version 0.
- **Former CR-07 resolved for same-action claimed reclaim:** only the transaction that inserts an intent receives `created`; a successor turns the old `claimed` intent `uncertain` and cannot dispatch it. SQLite and the memory test store implement the same transition.
- **Former CR-09 resolved:** completed intents are bound to their original lease token. A replacement attempt cannot replay `call-1` or create `call-2`; both persistence implementations reject it, whereas two tool calls in the same execution attempt remain allowed.

Focused lease/core tests passed (44), as did `bun test` (189), `bun run eval:phase-02` (33), `bun run test:phase-02-design-slice`, and `git diff --check`. The former CR-09 manual reproduction now yields one effect, a stale first result, and a denied retry.

---

_Re-reviewed: 2026-08-04T15:09:39Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: deep_
