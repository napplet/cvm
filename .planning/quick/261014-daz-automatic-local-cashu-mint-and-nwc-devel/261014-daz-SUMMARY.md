---
status: complete
date: 2026-10-14
commit: dc17cd9
---

# Local Cashu and NWC development environment

Implemented a three-container upstream stack: Nutshell 0.19.1 FakeWallet, Alby Hub 1.24.1 using that Cashu mint, and nostr-rs-relay 0.9.0. Versions and image digests are pinned. `bun scripts/dev-payments.ts` automatically starts services, waits for readiness, creates/unlocks a persistent wallet, provisions an NWC connection, funds it with fake sats, and writes a fresh Cashu token plus connection details to ignored mode-0600 JSON. Stop and reset commands are provided. No new dependencies.

`bun scripts/dev-payments.ts test` provisions an independent stack with random project name and ephemeral loopback ports. Tests exercise Cashu mint/swap/spent-proof replay rejection, signed encrypted NWC info/balance/invoice lookup/payment/replay, and persisted wallet identity/balance after restart. Cleanup runs in finally. CI workflow added; no external wallet secrets required.

## Validation

- Payment e2e: 1 passed, 14 assertions, 13.25 seconds on Docker Desktop / Apple Silicon; temporary stacks removed.
- Existing suite: 677 passed, 1 explicit Docker-test skip, 0 failures, 5177 assertions, 17.01 seconds with external effects denied.
- Compose config and git diff whitespace validation passed.
- Persistent development setup executed repeatedly, producing ready funded wallet and fresh token. Development stack remains running for use.
- TypeScript standalone check unavailable: repository does not install a tsc binary. Runtime tests passed.

## Decisions and limits

- Nutshell 0.21.0 default v2 keyset IDs stalled the Hub Cashu wallet; 0.19.1 v1 keysets passed all protocol tests.
- Direct Bun script entry points preserve the immutable root package approval. Adding package.json command aliases initially caused two expected approval-input-drift failures; those aliases were removed and all existing tests then passed. Approval records and verifier logic were not changed.
- Local HTTP mint use is confined to this development harness; production HTTPS policy, operator Keychain, funding readiness, and release evidence remain unchanged.
- FakeWallet settlement covers protocol integration, not real Lightning routing or full CEP-8 ledger/generation e2e. Phase 7 live certification remains pending.
- Upstream sources and operation instructions are documented in docs/runbooks/development-payments.md.
