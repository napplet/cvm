---
id: 261118-tcs
status: complete
date: 2026-11-18
---

# Sponsored test credits for operator pubkeys

`TestCreditSponsor` reuses the payment-free grant path for pubkeys listed in
`NAPPLET_CVM_TEST_SPONSORED_PUBKEYS`: each cap-bearing request (funded
admission, start, revise, cap approval) first grants exactly the requested cap,
idempotently per request key, up to 1,000,000,000 credits per request. Other
pubkeys are unaffected and top-ups remain enabled. The development composition
refuses to start with the setting unless payments are development-only test
credits and the database realm is absent or `test`.

Existing holds are not released; "available" reflects grants as sessions start.
The operator repository sets the pubkey for the private test-credit workspace.

Validation: payment and ContextVM suites (22 pass, including the new sponsor
test), TypeScript clean, operator CVM unit tests pass. Public PR #118.
