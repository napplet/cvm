---
type: quick
status: planned
---

# Automatic local payment development environment

Use upstream Nutshell FakeWallet, Alby Hub with Cashu backend, and a private Nostr relay. Automate setup, test funding, connection-file creation, teardown, and isolated e2e execution. Keep all endpoints local and credentials under ignored .local; never create release funding evidence. Validate actual Cashu mint/swap/replay rejection and encrypted NWC invoice/balance/payment requests against running services. Document one-command startup and tests; record any unsupported production boundary explicitly.
