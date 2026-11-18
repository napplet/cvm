---
id: 261118-tcs
mode: quick
---

# Sponsored test credits for operator pubkeys

1. Add `TestCreditSponsor`: reuses `FreeCreditAccess` grants for listed pubkeys
   only, never excludes other pubkeys and leaves top-ups enabled.
2. Call it at the existing four cap-bearing tool sites in the ContextVM adapter.
3. Development composition reads `NAPPLET_CVM_TEST_SPONSORED_PUBKEYS`; startup
   fails closed unless payments are development-only test credits and the
   database realm is absent or `test`.
4. Operator repository sets the pubkey for the homelab test-credit workspace;
   deploy with the existing `./homelab cvm deploy` lifecycle.

Verify: unit test (listed pubkey granted per cap and idempotent, others not
granted, non-cap tools no-op), payment/ContextVM suites, TypeScript.
