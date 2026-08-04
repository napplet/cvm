# Phase 4: Metered Generation & Revision Loop - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-04
**Phase:** 4-Metered Generation & Revision Loop
**Mode:** `--auto` single pass with codebase assumptions analysis
**Areas discussed:** price-versioned settlement, provider ambiguity, session/revision lifecycle, bounded repair, napplet harness and verification, ContextVM status and evidence

---

## Price-Versioned Settlement

| Option | Description | Selected |
|---|---|---|
| Reserve ceiling, settle actual receipt | Pin price/model profile at authorization, debit normalized actual usage, release the unused reservation. | ✓ |
| Debit the ceiling | Treat the action maximum as a fixed fee. | |
| Reprice after completion | Apply whatever price card is current when the receipt arrives. | |

**Auto-selected choice:** Reserve ceiling, settle actual receipt.
**Notes:** Required by BILL-03/BILL-04 and preserves Phase 3's hold-not-fee contract.

## Provider Ambiguity

| Option | Description | Selected |
|---|---|---|
| Durable operation plus `usage_unknown` | Persist intent before I/O, query the original operation, and block later billable actions until reconciled. | ✓ |
| Blindly retry | Create a new provider call after timeout or response loss. | |
| Treat timeout as zero usage | Release funds even though the provider may have processed the request. | |

**Auto-selected choice:** Durable operation plus `usage_unknown`.
**Notes:** A provider that cannot correlate and reconcile remains blocked/unselected.

## Session, Revision, and Artifact State

| Option | Description | Selected |
|---|---|---|
| Separate action lifecycle and verified artifact version | Failures/unknowns persist diagnostics but retain the prior verified artifact; workspace lineage is checkpoint-bound. | ✓ |
| Every terminal action advances artifact | Treat failed or incomplete output as a new artifact version. | |
| Live worker is session state | Depend on one worker surviving across revisions. | |

**Auto-selected choice:** Separate action lifecycle and verified artifact version.
**Notes:** Supports durable replay and Phase 5 continuity without labeling failures as usable artifacts.

## Automated Repair

| Option | Description | Selected |
|---|---|---|
| One separately authorized automatic repair | Validation may trigger one bounded repair action, then further repair requires a signed revision. | ✓ |
| No automatic repair | Return immediately after the first build failure. | |
| Repair until cap exhaustion | Let the agent consume the remaining cap through an open-ended loop. | |

**Auto-selected choice:** One separately authorized automatic repair.
**Notes:** Satisfies GEN-05 while avoiding an unbounded self-directed spend loop.

## Napplet Harness and Verification

| Option | Description | Selected |
|---|---|---|
| Project-owned harness over trusted napplet packages | Use `@napplet/skills`, promoted CLI/boilerplate, and the Phase 1 verifier behind existing typed worker boundaries. | ✓ |
| New authoritative protocol implementation | Reimplement NIP-5D and napplet conformance in the CVM. | |
| Agent-selected arbitrary tooling | Let generated code change package pins, verification, and build authority. | |

**Auto-selected choice:** Project-owned harness over trusted napplet packages.
**Notes:** Napplet packages remain the authority; fixes chase package behavior rather than fork the protocol.

## ContextVM Status and Evidence

| Option | Description | Selected |
|---|---|---|
| Thin owner-scoped routes with safe durable status | Expose progress, spend, reconciliation, verified artifact identity, diagnostics, and next action without raw prompts/provider payloads. | ✓ |
| ContextVM types in the core | Couple generation and accounting to the living transport protocol. | |
| Preview/publish from Phase 4 | Treat successful generation as publication authority. | |

**Auto-selected choice:** Thin owner-scoped routes with safe durable status.
**Notes:** ContextVM is the only v1 surface; preview and publication remain Phase 6.

## the agent's Discretion

- Exact state/error names, schema layout, price-card integer representation, and status pagination.
- Conservative action/model ceilings and safe diagnostic summaries.
- The smallest frameworkless harness and deterministic provider fake that proves the loop.

## Deferred Ideas

- Ten-minute top-up pause, checkpoint retention, explicit resume, and expiry — Phase 5.
- Preview, capability consent, signing, publication, and attestation — Phase 6.
- Live provider promotion, p95/SLO, chaos, regional, and launch proof — Phase 7.
- x402/L402 and rich inputs — v2.
