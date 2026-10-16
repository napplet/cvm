---
status: complete
workflow: gsd-quick (inline)
---

# Persist browser Nostr authentication

1. Remember NIP-07 selection locally and reacquire the public key on return. Save NIP-46 connection credentials locally in interoperable nbunksec form and reconnect without another QR pairing.
2. Verify restored identities before enabling account actions; preserve in-flight signer leases, explicit sign-out, and recoverable offline sessions. Restore the appropriate CVM client for saved projects.
3. Verify extension reload, remote-signer reload/signing, logout, malformed/offline sessions, and existing publication flow. Document local credential storage, record checks, and push the verified change to main.

No generation or publication is triggered by restoring authentication. Provider accounts remain private to the CVM.
