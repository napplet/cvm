---
quick_id: 260806-dxc
status: complete
completed: 2026-08-06
commit: 0041419
---

# Quick Task 260806-dxc Summary

Ordinary development now uses an authority-free local certifier configuration selected by one stable environment variable. The nine phase-numbered release/certification variables were removed from runtime command configuration.

## Delivered

- Added `src/certification/config.ts` with strict local/protected schemas.
- Added the ignored developer `.env`, committed `.env.example`, and `config/certifier.local.json`.
- Consolidated protected deployment configuration behind `NAPPLET_CVM_CERTIFIER_CONFIG` and `NAPPLET_CVM_CERTIFIER_CONFIG_SHA256`.
- Updated certification, release, reproducibility, and supply-chain commands to use the shared boundary.
- Added configuration, pinning, local-authority, and command regression coverage.

## Safety properties

- Local mode contains no adapter, trust root, credentials, or protected evidence authority.
- Local mode cannot load a protected adapter or promote a release.
- Protected mode requires an absolute config path and an out-of-band SHA-256 pin.
- Missing or malformed protected configuration remains blocked and nonzero.

## Verification

- `bun test --timeout 10000`: 522 passed, 0 failed, 4,310 assertions.
- Local protected-certification preflight: eight blocked records, exit 1.
- Local protected release verification: `protected_configuration_unavailable`, exit 1.
- Runtime `process.env.PHASE07_*` configuration references: none.

TypeScript whole-repository checking remains affected by pre-existing repository errors outside this task; the changed paths are exercised by the passing Bun suite.
