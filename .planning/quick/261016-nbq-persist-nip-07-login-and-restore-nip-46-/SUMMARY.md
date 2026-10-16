---
status: complete
workflow: gsd-quick (inline)
---

# Persistent Nostr sign-in

NIP-07 remembers the selected method locally and reads the extension public key on return. NIP-46 saves the local connection as an interoperable nbunksec using pinned `applesauce-signers@6.2.3`, reconnects with the same client key, and confirms the user public key before exposing the identity. Saved credentials survive offline/locked signers and support explicit reconnect; malformed records are discarded. Sign-out clears persistence across tabs, late restores cannot reverse it, and existing signer leases keep authorized builds running.

The workspace records the owner of saved actions and restores the matching signed CVM client and verified preview on reload. New builds await identity restoration rather than silently choosing another account. Signed CVM access checks remain authoritative; cached public keys never grant access.

All four focused browser/service journeys passed, including 304 responsive checks. The existing 424 TypeScript diagnostics remain unchanged. See VERIFICATION.md for exact coverage and limits.

Default development service restarted after confirming zero active model actions; ready at http://127.0.0.1:49371, PID 89832, with saved ChatGPT OAuth mode retained. A fresh Chromium smoke check confirmed the updated identity bundle, connected workspace, and zero browser errors without any model request. Original worker image unchanged; root dependency hashes explicitly refreshed for the added codec dependency.

Existing sign-ins created before this change have no persistent credential record and need one sign-in/pairing after upgrading. Thereafter the same origin/CVM restores them automatically. Clearing site data or revoking the remote session requires sign-in again. No external signer app was manually tested; protocol-compatible encrypted signer fixtures cover the reconnect behavior.
