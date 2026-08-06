---
quick_id: 260806-dxc
status: complete
description: Replace Phase 7 env sprawl with product-level certifier configuration and safe local .env defaults
---

# Quick Task 260806-dxc Plan

## Goal

Make ordinary local testing require no protected release configuration, replace phase-numbered operator variables with stable product-level names, and provide a safe local `.env` that cannot claim protected-live certification.

## Tasks

1. Add a typed certifier configuration boundary with stable `NAPPLET_CVM_*` environment names and explicit local/protected modes; keep protected commands fail-closed.
2. Add ignored local `.env` defaults plus a committed example, and update certification/release/reproducibility command entrypoints to use the shared configuration.
3. Add regression tests and documentation proving local tests need no protected values while protected certification still rejects absent or malformed authority; run the full test suite.

## Verification

- `bun test --timeout 10000`
- local preflight runs with the repository `.env` but cannot emit a protected pass
- protected release verification remains nonzero without protected configuration
- no `PHASE07_*` environment variables remain in runtime command configuration
