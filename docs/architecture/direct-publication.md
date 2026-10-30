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

`prepareUploadAuthorization({principal,idempotencyKey})` requires that accepted
owner event and the currently owned verified artifact. It captures the exact
BUD-11 template by invoking the pinned CLI's authorization function with a
capture-only callback that stops before signing. The strict
`direct-upload-authorization-v1` record binds the intent/review, owner event,
raw HTML hash, separate archive checksum, fixed server, helper checksum,
template and expiry. Its digest determines the original signing operation.
Concurrent preparation and lost commit acknowledgement recover that one record;
later calls cannot rotate its timestamp or replace it.

`loadUploadAuthorizationForSigning` revalidates current ownership, intent,
configuration and expiry. The client helper `signDirectUploadAuthorization`
requires the expected authorization digest, intent, review and owner before
calling the existing owner signer with a copy of the actual CLI template. It
then checks the complete public event, signature and every template field.
Authenticated client presentation still supplies provenance and actual consent.
The CVM accepts no owner private key.

`acceptUploadAuthorization` retains only a verified public signature and checks
current state before its first acceptance. Concurrent acceptance, lost
acknowledgement and another valid signature of the same event recover the
original retained signature. Historical `readUploadAuthorization`,
`readAcceptedUploadAuthorization`, preparation replay and accepted-event replay
survive expiry; an expired first acceptance or new preparation is refused.
These methods create no upload, signer request, relay event or service signature.
They are ordinary owner preparation, with no certification receipt requirement
and no provider-effect authority. They remain private and unselected pending
the negotiated public surface and actor composition.

`openProductionDirectCertificationNip46Signer` composes those actual retained
records with the receipt-gated production NIP-46 transport. Its fixed principal
and idempotency identity resolve the original CLI owner and BUD-11 templates;
callers cannot supply another template or context resolver. New signing checks
the current owned artifact, configuration and intent before discovery, request
construction, dispatch fencing and immediately before relay publication.

The transport checks signed and dispatching originals before discovery. A
completed signature returns its verified original public event. An uncertain
request queries only its retained encrypted NIP-46 response, including after
receipt/intent expiry or configuration change. It does not initiate discovery
or sign again. If the final fresh check fails after the dispatch fence commits,
that original remains query-only even when no relay publish occurred.

Local proof uses the actual funded direct artifact, CLI/Chromium output,
NIP-44 encrypted NIP-46 relay messages, a disposable owner bunker and restricted
PostgreSQL. Owner keys stay in the fixture bunker, distinct from the disposable
client key supplied to production code. This is mechanism proof, not protected
release evidence or production signer consent. The factory remains unselected
and certification-only. Ordinary post-cutover signing still needs its approved
actor composition and must not inherit release receipt expiry.

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

### Prepared receipt-gated direct upload transport

`createExactDirectSealedUploadAdapter` and
`createProductionDirectCliUploadPort` provide a separate certification transport.
Its strict `direct-sealed-upload-v1` scope binds the raw HTML hash, distinct
archive checksum, signed owner event, original intent and operation, server,
candidate/topology/effect plan, retention intent and exact authorization pair.
The transport accepts a completed public BUD-11 event. It never accepts a user
private key or invokes a remote signer. The actual pinned CLI must reproduce
that event's exact authorization template; an unscoped fallback is refused.

The restricted PostgreSQL journal transitions once from prepared to dispatching
before any network request. A lost commit acknowledgement, auth failure,
redirect or ambiguous provider response cannot authorize redispatch. Recovery
uses only the original operation and a bounded GET that verifies exact length
and raw hash. A positive upstream HEAD is replaced with this same byte check.
Original observation remains available after receipt, token and intent expiry;
each new PUT revalidates current receipt/intent/token immediately before sending.
The retained retention period describes approved intent, not measured Blossom
retention or a server SLA.

Run `bun scripts/test-direct-upload.ts` for disposable local TLS and restricted
PostgreSQL proof. The test covers ambiguous responses, expiry during preflight,
lost dispatch commit acknowledgement, concurrent calls, incorrect stored bytes,
scope/signature rejection, and query-only recovery. Fixture keys and receipts
provide mechanism evidence only; no protected upload or release proof is produced.

The historical promoted `0.5.2` aggregate facade is not a direct-format adapter.
These new upload modules are not selected by the runtime or wired to a direct
publication producer. Ordinary post-cutover owner publication must use its own
approved actor composition, rather than inherit an expired certification receipt.
Root artifact/intent-derived upload configuration, end-to-end supported signer
and upload/relay operation composition, relay observation, service attestation
and certification
remain open. No
handwritten NIP-5D manifests, hash reinterpretation, signer bypass or fabricated
completion evidence are permitted. Production client presentation and negotiated
ContextVM/MCP/SDK/catalog wiring also remain open. Live effects require the exact
controller-issued bounded authorization and all production release gates.
