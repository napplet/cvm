---
status: complete
completed: 2026-10-16
commits: [f75c8ed, 1f22c4d]
---

# Static workspace, private CVM administration and identity-owned publication

Implemented inline through GSD quick. The scope expanded through the user's explicit decisions to cover static hosting, private operator controls, Blossom, publication destinations, project ownership and the integrated collection page.

## Delivered

- Public workspace exports as static files. Its configuration contains only relay URL and CVM public key; service operations use signed encrypted ContextVM. Private provider account/API controls moved to an allowlisted CVM admin with immutable rates and pending/active/finished job details. Existing subscription authorization is preserved.
- Independent Anonymous, NIP-07 and NIP-46 identity selection is available during generation. NIP-46 defaults to a NostrConnect QR. Captured signer leases preserve in-flight identity when the selected identity changes.
- Verified artifacts receive CVM-owned Blossom blobs, a CVM preview event and copyable naddr. Blossom implements BUD-01/02/04/11 basics with CVM-only writes.
- Contextual Publish is step 4 of the applet flow. Pinned upstream CLI code prepares the exact event, the client obtains the user's signature, mirrors/hash-checks blobs, and submits the exact signed event for relay publication/readback. Per-file/per-relay progress and durable retries preserve publication identity.
- Blossom kind-10063 and NIP-65 write-relay discovery (through purplepag.es), validated Enter-to-add destination chips, manual fallback, and advisory NIP-66 relay suggestions. Missing user lists never silently select the CVM relay.
- Local durable project registry uses the verified CVM request signer. Strict list/get/rename inputs contain no owner field; cursor, session, artifact and continuation access are owner-scoped.
- Your applets is a dedicated static hash route (`#/applets`) with shared navigation, stage filters, pagination, status refresh, desktop/mobile cards, and back/forward. The current generation/preview stays mounted when navigating.
- Fixed the reported missing-project case: the old list queried only the selected identity, omitting earlier anonymous work. Separate signed CVM requests now list both **Your account** and **This browser**. Legacy sessions with only funding-account hashes are recovered when the original key proves ownership. Opening a browser project keeps its CVM signer separate from the selected publication identity. No ownership transfer or arbitrary pubkey lookup was added.

## Verification

See `261016-hh8-VERIFICATION.md`. Final browser journeys passed for returning users and anonymous legacy recovery, full generation/revision/reload recovery, and separately hosted static publication. Focused suite: 70 passing tests before the collection follow-up; 16 applicable identity/adapter/progress tests repeated afterward. Static export and vendor rebuild passed. Root package and lockfile hashes are unchanged.

The running default service was restarted only after SQL reported zero active metered actions. It is ready at http://127.0.0.1:49371 in chatgpt-oauth mode. A read-only browser smoke verified direct collection navigation, preserved draft, browser back/forward and mobile layout. Reload the existing tab to retain its anonymous key and recover its older applets.

## Limits retained

Production is deferred. These integration tests use a model/OAuth fixture with real local relay, Cashu, SQL, isolated Docker workers, preview and Blossom; they do not perform public publication or spend a real subscription allowance. Older uncertain operations remain fenced. Anonymous identity belongs to the tab and may be lost when it closes; account projects are recoverable elsewhere by signing in with the same npub. No cross-owner migration is implied.

Global TypeScript checking still reports 424 existing diagnostics; the normalized diagnostic set has no new signatures. Upstream QR source whitespace is preserved byte-for-byte for provenance; first-party diff checks pass. Node.js 22+ is required by the bounded publication relay adapter to retain DNS pinning and TLS hostname validation on this Bun version.
