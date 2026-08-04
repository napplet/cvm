---
phase: 03-contextvm-funding-funded-admission
fixed_at: 2026-08-04T00:00:00Z
review_path: .planning/phases/03-contextvm-funding-funded-admission/03-REVIEW.md
iteration: 1
findings_in_scope: 9
fixed: 9
skipped: 0
status: all_fixed
---

# Phase 03: Code Review Fix Report

## Fixed Issues

### CR-01 / CR-02 / CR-06

Public ContextVM admission now accepts no client capacity fact and uses the injected server authority. Top-ups invoke rail coordinators; composed durable surfaces configure a truthful announcement and combined owner status.

### CR-03 / CR-04

`PostgresSqlFundingStore` runs actual PostgreSQL-wire serializable transactions and maps SQLSTATE `40001`. Lightning and Cashu lifecycle repositories now have PostgreSQL implementations; Cashu claims a unique proof commitment before provider I/O.

### CR-05 / CR-07 / WR-01

Cashu reconciliation is query-only, amounts are bounded before sealing/swap, and capacity attempts are atomically dispatch-fenced with trusted lease-expiry validation.

### WR-02 and security redaction

Every reference fixture invokes its own deterministic oracle. Design evidence rejects bearer/secret material in primitive values and requires the Phase 3 threat mapping.

## Verification

- `bun run eval:phase-03` — pass
- `bun test` — 265 pass, 0 fail

_Fixer: gsd-code-fixer_
