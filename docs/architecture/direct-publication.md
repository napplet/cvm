# Direct publication preparation

The ordinary production dependency graph constructs `directPublicationIntents`
from the concrete owned artifact reader, stable service request journal, approved
Blossom origin and configured relay set. This prepares owner approval and retains
completed public signatures. It performs no signing, upload, relay publication,
model request or accounting mutation. Public ContextVM/MCP tools do not expose
these methods yet; their negotiated integration remains required.

The contract is explicitly `direct-publication-review-v1` /
`direct-publication-intent-v1`. It preserves the direct HTML hash separately from
the sealed archive checksum. It creates no legacy aggregate or replacement
manifest and changes no historical publication schema or operation key.

## Owned review and durable approval

`review({principal, sessionId, artifactId})` first reads the actual finalized
owned artifact. The reader checks real-account ownership, original request,
approved original direct toolchain, exact object bytes and original structured
verification evidence. The resulting review includes the original CLI-generated
manifest template, direct artifact/archive/evidence/policy/toolchain identity,
capability declarations, exact single-file metadata and approved destinations.
It contains no generated source, caller destination overrides or signer material.

Reviewing grants nothing. A trusted client displays this review and submits
`prepare({...identity, idempotencyKey, approval:{consent:'approved', reviewSha256}})`
through an authenticated principal call site. The server derives the account,
recomputes the current review and requires the matching digest. An immutable
intent expires after 30 minutes. The original CLI template, including ordered
tags, content and original timestamp, stays byte-for-byte equivalent as NIP-01
event fields; the intent does not rewrite an older manifest's timestamp.

The owner-scoped idempotency key selects one original record. Concurrent calls
and lost commit acknowledgements read the same durable winner. A changed request
under that key conflicts. Observation can return the original after expiry or a
configuration change; that grants no new signing or publication authority.
`loadCurrentForSigning` additionally rechecks expiry, current ownership, verified
artifact and exact current destinations/review. An unselected or changed profile,
missing artifact or changed relay set blocks new signing.

The journal uses new versioned prefixes inside the existing service-scoped
authority. It creates no database schema, admission, reservation or provider
operation. Existing source/profile configuration remains unpromoted.

## Owner signing boundary

The client helper receives the intent from an authenticated service response and
the separately confirmed intent/review/owner identity:

```ts
const event = await signDirectPublicationIntent({
  intent,
  expected: {
    intentId: confirmedIntentId,
    reviewSha256: approvedReviewSha256,
    ownerPubkey: connectedOwnerPubkey,
  },
  sign: template => ownerSigner.signEvent(template),
});
```

The callback is the existing supported NIP-07/NIP-46 signer. The helper refuses a
stale or substituted approval before invoking it, passes a copy of the exact CLI
template, and verifies the returned public NIP-01 event's hash, signature, owner
and every original field. It never receives a private key, creates a manifest or
publishes an event. Review/intent digests provide consistency and binding; they
do not replace authenticated transport provenance or the user's approval.

`acceptOwnerEvent({principal,idempotencyKey,event})` rechecks the original intent,
current ownership/review and expiry before retaining a new completed public
signature. Concurrent acceptance and lost commit acknowledgement observe the
original record. Another valid signature of the same immutable event returns
the originally retained signature. Substituted owners/templates or unknown key
fields refuse. `readAcceptedOwner` and an exact replay can observe that original
after expiry, but a new expired acceptance is forbidden. Accepted means retained
public signature only; it does not mean uploaded or published.

## Remaining publication work

The pinned direct CLI source is `napplet/web` commit
`3c6e3ae33fea425b2f151740c0bd8c02f509ef7b` (`0.13.0`), described by the prepared,
unpromoted source recipe. Its separately reproduced three-function network
helper is retained under `vendor/napplet-cli-3c6e3ae3`, with actual bundle SHA256
`2e50a73810bf8017b9569dd771842326b8ecc254dd912e92aaf9a43ab3a1a756`.
`loadPinnedDirectCliNetworkHelpers` validates exact source/runtime/lock provenance,
hashes the same bytes it imports, rejects extra exports and validates returned
records. It exposes only the actual upstream authorization, upload and relay
functions, with no module-path or implementation replacement input. No network
effect occurs at import. The historical two-export helper remains unchanged;
its bytes also reproduced from the newer source with that same two-export surface.

Two clean direct-source checkouts each produced two matching fixed-path builds,
with networking disabled on each second build. The updated builder's default
legacy profile also reproduced its original exact bundle hash. Local tests use
the actual new helper over real loopback HTTP and Nostr WebSocket fixtures;
they are transport mechanism evidence, not production certification.

Its typed upload function can fall back from a scoped
server authorization to unscoped authorization after an auth-shaped error.
Future exact signing must refuse an unapproved downgrade. An ambiguous result
must reconcile the original operation; it cannot blindly sign or dispatch again.
The primitive also trusts a positive HEAD response to skip upload. The production
adapter must independently fetch and verify exact bytes before treating that as
successful storage. Source-level tests demonstrate both behaviors and the exact
signer's refusal before a second PUT or an unscoped signature.

The historical promoted `0.5.2` aggregate facade is not a direct-format adapter.
The current direct helper is prepared and verified, but exact upload
authorization, retained effect identities, upload/relay observation, service attestation and supported
user-owned NIP-46 flow still need complete composition and certification. No
handwritten NIP-5D manifests, hash reinterpretation, signer bypass or fabricated
completion evidence are permitted. Production client presentation and negotiated
ContextVM/MCP/SDK/catalog wiring also remain open. Live effects require the exact
controller-issued bounded authorization and all production release gates.
