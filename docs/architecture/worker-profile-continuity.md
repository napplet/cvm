# Worker profile continuity

A default worker image is authority for new work. It is not evidence of the
image used by a retained operation. Provider operation records own the immutable
image, toolchain, lease, deadline, provider and resource identity.

Capacity writers now retain their execution image, toolchain, policy and Fly
region before dispatch. Readers preserve pre-profile records and their existing
journal keys and identity digests. They verify those records against the original
provider journal before returning usable capacity. The returned image digest
comes from that provider original. A changed default cannot relabel an old Fly
worker, even when the Fly transport correctly observes its original image.

Reservation retries refuse a changed image, toolchain or region before entering
the provider client. A bound resource needs readiness observation only. An
unbound original still enters the provider client's durable original-claim
reconciliation path; it must not issue another provider create. This check does
not replace the transport's ownership and readiness checks.

Legacy records are not backfilled implicitly. Their original provider intent
must prove compatibility before a reservation retry. Observation also requires
matching resource IDs, lease, deadline and policy. Missing or inconsistent
originals return unknown. No new capacity identity, replacement worker or budget
authority is created by observation.

Rollback keeps all records and existing identities. An older reader tolerates
the additional execution field. Retain the matching old image and toolchain;
rolling a default back does not migrate an active job.

## Cleanup after a lost worker creation response

Cleanup can recover a missing native ID without invoking CREATE, including
after the original creation deadline. Both transports first read the durable
original request. Only records that reached dispatching, dispatched, unknown or
reconciled are eligible; a merely claimed record cannot trigger provider lookup.
Missing or ambiguous lookup cannot prove that an in-flight creation never ran.

Modal requires the exact provider application, image, policy, lease, toolchain,
deadline and full server-held request tag set. Fly uses the existing exact
operation/request metadata, image and isolation configuration checks, additionally
requires the original region and a provider creation time no later than the
original deadline, then retains that creation time with the recovered native ID.
Fly exposes these provider fields in its
[Machines API](https://machines-api-spec.fly.dev/models).
Neither transport accepts a replacement ID or rewrites the original request.

`observeTermination` may bind these verified facts to the existing SQL original;
it dispatches no creation, worker command or termination. `terminate` performs
the same resolution before the existing independently journaled termination
fence. An uncertain termination is still observed, never issued again. A missing,
duplicate, foreign, unavailable or mismatched observation leaves cleanup unknown.
Retain the original provider app, executable profile and journal access for this
recovery; current defaults cannot supply missing authority.

Local native-boundary fixtures and restricted PostgreSQL checks exercise lost
CREATE responses, expired creation deadlines, fresh controller instances, native
ID persistence, wrong identities and lost termination acknowledgements with one
CREATE and one termination. They are mechanism proof, not live provider evidence.
Truly absent native resources, abandoned capacity claims and fresh funded CREATE
certification still need their own end-to-end proof. No production profile or
isolation gate is selected by cleanup.

## Readiness after a lost worker creation response

Native readiness observation now uses that same exact original resolver instead
of requiring the caller to retry CREATE. It performs only provider identity
queries and the existing fixed trusted isolation probe against the recovered
ID. Missing originals cause no provider I/O. Merely claimed, expired, terminating
or terminated originals cannot gain readiness. After an asynchronous probe, the
native transport rereads its original and rejects concurrent retirement or expiry.
Cleanup remains available after the creation deadline under its separate fence.

The capacity layer first verifies its persisted execution, lease and deadline.
It permits native observation to resolve a missing ID, rereads that same provider
original afterwards, and checks again after readiness persistence. A changed ID,
execution binding, expired deadline or retirement yields unknown. Repeated reads
retain the original admission readiness rather than substituting a later probe
timestamp. Existing image selection, cap holds, admission counts and thresholds
are unchanged; no replacement worker or queue is introduced.

Local native-port tests exercise incorrect identity, unavailable lookup, invalid
isolation probe, retirement during a probe and completion after the original
deadline with one CREATE per original. Restricted PostgreSQL tests construct
the actual native clients and capacity layer with fresh journal instances;
they prove recovered ID persistence, exact original readiness, expiry during a
provider call, and refusal of later expired observations before provider I/O.
This closes the local recovery mechanism, not live provider readiness, the
five-second admission SLO or the full funded generation certification path.

## Native termination retires the original readiness authority

Termination has its own durable `t-*` operation, but the original CREATE row is
also a readiness authority. Both transports now mark that original `terminating`
after claiming the exact termination identity and before provider lookup or
termination dispatch. They retain the existing independent dispatch fence;
ambiguous deletion never permits another DELETE or terminate call. Confirmed
disappearance of the already bound native ID records the original `terminated`.
Missing-ID or ambiguous identity lookup cannot supply that proof.

Before granting readiness, transports also query the exact existing termination
companion. This covers older controllers that wrote a termination record while
leaving their CREATE row reconciled. A matching companion monotonically retires
the original through the existing SQL journal states; an inconsistent companion
refuses readiness. Reading it creates no new termination or provider effect.
Original operation IDs, termination IDs and request digests remain byte-compatible.

Native and capacity checks reject an already-running probe if the original
retires while it waits. Local regression tests hold an actual native DELETE or
Modal terminate in flight, attempt concurrent readiness while the resource is
still visible, then lose the termination response and query the original.
Restricted PostgreSQL tests compose the real native clients and capacity layer.
Each original has one CREATE and one termination. Historical companion tests
perform no new provider mutation. These tests are local mechanism proof.

Retain original and termination rows during rollout and rollback. Earlier
readers must keep the original retirement fence; never clear it to restore
availability. This change authorizes neither refund nor abandonment of a paid
action. Broader abandoned-capacity discovery, action/hold ownership, terminal
reconciliation and any financial release require their own exact SQL proofs.

## Remaining promotion requirements

This change is a safety prerequisite, not complete upgrade recovery. Before
selecting another production worker profile:

- Establish the service journal authority under the original topology before
  changing it. Ordinary journals now retain that original scope; unanchored
  history in another scope refuses startup rather than guessing or copying
  originals. Preserve the authority record and journal/audit tables in backup.
- Retain approved original executable profiles in mounted candidate configuration.
  The bridge now routes legacy aggregate jobs through the original provider
  image/toolchain and app binding. Keep those provider apps and credentials
  available through the resume window. Direct-profile promotion and original
  resume allocation still require their complete compatibility wiring.
- Select approved original checkpoint compatibility before reserving resume
  funds or allocating capacity. The continuation service currently accepts one
  current policy/model/price/toolchain tuple. Do not reprice an old action or
  accept caller-controlled compatibility pins.
- Prove mixed-version operation, restart, encrypted fresh restore, the 30-day
  explicit resume window and rollback. Keep certification authorization scopes
  separate from ordinary service continuity.

The prepared direct-artifact image remains unselected. Restricted-Postgres and
transport fixture tests establish local regression behavior; they are not live
Modal/Fly, admission SLO, host or release-certification evidence.


## Service journal authority

Ordinary capacity, worker, job, request, Vertex, checkpoint, ContextVM and NWC
journals now share the service's initial scope across releases. Bootstrap derives
the service public key from the mounted signer and checks it against the configured
service identity before opening these journals. No user key or inbound principal
can select this identity.

The authority is a strict version-one value in the existing restricted SQL
operation journal, with a fixed namespace/key and a fixed discovery scope. Its
identity digest commits to the service public key and original scope. Readers
require revision one and an exact digest. Changed identity, edited authority or
unanchored history in any other ordinary scope refuses startup. Later
ordinary records in a competing scope also refuse startup; current-topology
certification records are excluded from that ordinary-history check. The existing
audit trigger records creation; no extra schema or implicit row migration is
required. The exclusive service database is the ownership boundary for initial
adoption; it must not be shared across independent service identities.

The first rollout is an expansion under the existing configuration. Quiesce and
back up as required by the migration runbook, install this reader/writer, and
establish the authority before changing topology. Retained operation keys, row
values and identities remain byte-for-byte unchanged. Concurrent regional boots
serialize authority establishment. Future topology changes read the same anchor.
Ordinary capacity also selects an existing intent's original provider before
applying the configured default to new work.

Certification/control journals, including the receipt broker and Google mutation
journals, retain their current topology scope. Service continuity grants neither
new provider authority nor an expired certification receipt. Shared provider
originals still retain their exact original operation identity and profile checks.

Back up and restore the complete SQL operation journal and audit, including the
service-continuity authority. A local PostgreSQL dump/fresh-database drill proves
this record and uncertain operation IDs survive a database restore. It does not
prove live Cloud SQL/GCS recovery, the full encrypted checkpoint path or any of
the eight protected suites. Rollback retains the authority; a pre-continuity binary
must use the original topology configuration until the same reader is backported.
Fresh restore requires the backed-up authority and rebuilds worker clients against
the recovered database instead of retaining source-pool provider journals.
Never delete the authority or copy an uncertain operation into a new scope.

Historical job/worker profile selection and resume compatibility are still
required before changing the selected worker image. This change keeps their
original records reachable; it does not approve a different executable profile.


## Retained job executables

Mounted `worker.retainedProfiles` holds at most eight pinned approved
image/toolchain pairs alongside the current default. Each retained entry has
`artifactContract: "legacy-aggregate-v1"` or `"nip5d-direct-v1"`. Omitting the retained-profiles field preserves existing
configuration. Duplicate images, floating tags, unknown fields and contracts are
refused. The controller/operator preparation must carry the approved original
profiles into the next candidate configuration before its authorization; customers
never provide these entries. Keep existing provider app identities during this
transition; moving to another app requires separately retained access authority.

The coordinator builds a client for each approved image. After the funded owner
and original capacity resolve, the job router reads the exact durable worker
operation, matches provider, image, toolchain, policy and original app, then creates
the job client for that executable. Requests and checkpoint bytes cannot nominate
an executable. An absent approved profile fails closed. Normal builds, fences,
exports, restore operations and restore observations use this router in both the
normal graph and the fresh recovered graph. New capacity still uses the default.

Query-only `observeTermination` selects that same original approved executable
without requiring an already bound native ID. This permits exact native lookup
after a lost CREATE response. The underlying transport still validates original
metadata, and absence without a bound native identity stays pending. Executable
job resolution continues to require a bound ID. The ordinary admission-capacity
observer uses this path; it cannot choose the current default for an older
operation or dispatch a replacement or termination.

The artifact index reader accepts original toolchains only from the approved
set; request/result/owner evidence and immutable object hashes remain checked.
Finishing an older job writes evidence with that job's actual toolchain, rather
than relabeling it with the new default. No old request, source body, job ID or
artifact evidence is rewritten. Uncertain job and restore operations keep the
existing query-only recovery path. These changes do not make the internal index
a customer publication/preview authorization endpoint.

The default worker may explicitly declare `artifactContract` as
`legacy-aggregate-v1` or `nip5d-direct-v1`. Omission preserves legacy behavior.
Retained profiles carry their explicit contract with the original image and
toolchain. The router uses the durable original provider record to select that
approved executable; requests and checkpoints cannot nominate a contract.
An explicit direct configuration changes candidate material and requires fresh
matching preparation, evidence and authorization before selection.

For direct jobs, private request preparation carries the authenticated original
bounded purpose in the existing `idea` field. The core checks that preparation
cannot change charged ownership, source, version, policy or purpose. Legacy
requests keep their original omission and hashes. Direct jobs use the direct
verifier, structured receipts and sealed archive version 3; legacy jobs keep
their existing verifier and encoding. Unsupported capabilities fail the CVM
policy instead of disappearing from the declaration. No contract fallback
reinterprets a direct artifact hash as a legacy aggregate.

The prepared direct image remains unselected in real configuration. Its owner
artifact reader, preview/publication composition and protected host/signing/Paja
evidence still need completion. A successful local build regression is not a
live provider, 30-day resume, host or release-certification result.

For a worker-default rollback, keep this control-plane reader installed, select
the previous approved default and retain the other approved image/toolchain in
the catalog. Preserve both sets of operation and artifact records. A binary
without retained-profile readers must not serve a mixed-profile database until
those readers are backported; restoring an older backup to discard newer
customer work is not a rollback strategy. Live quiesce/checkpoint, backup and
fresh restore remain mandatory cutover evidence.

For local legacy-profile paid-resume verification, set
`NAPPLET_CVM_TEST_REAL_WORKER_IMAGE` to the immutable Docker image ID of a
locally built production worker. The integration helper checks the installed
worker, job and bootstrap hashes against this checkout before starting it.
It mounts no host workspace or credentials, uses the offline toolchain, and
removes and observes absence of its bounded local container afterward:

```sh
NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny \
NAPPLET_RUN_POSTGRES_ISOLATION=1 \
NAPPLET_CVM_TEST_REAL_WORKER_IMAGE="$CVM_LOCAL_WORKER_IMAGE_ID" \
bun test tests/production/resume-pricing-preparer-postgres.test.ts --timeout 120000
```

This mode requires a real successful eight-command build, independent root
artifact verification, version advancement, exact receipt settlement and
original-worker cleanup. Its retained native command log verifies one build
start across accounting recovery. Without the image variable, the same test
keeps its deliberately conflicting proposal and verifies failed-build billing.
Neither mode supplies live provider evidence. The legacy Chromium report may
skip manifest, wire and teardown checks; those skips remain explicit and do not
satisfy current direct-profile, publication or release certification.

For the corresponding direct-profile local integration, also set
`NAPPLET_CVM_TEST_REAL_WORKER_CONTRACT=nip5d-direct-v1` and use an exact current
direct-profile image ID. This requires the structured wire check to pass and
verifies the actual HTML hash, capability tags and bounded manifest purpose.
Unsigned manifest and unmeasured lifecycle checks remain separate live gates.

The private `readVerifiedDirectWorkerArchive` validator accepts existing sealed
version-3 bytes only with an independently obtained object checksum, full
original build binding, and original bounded purpose. It checks account, owner,
session, action, version, proposal, toolchain and publication server, then reruns
the direct verifier against the stored HTML and original receipt bytes in a
fresh temporary directory. Only the literal `index.html` is materialized; no
stored code executes, and the directory is removed on success or refusal.
The CLI and plugin purposes must both match the original purpose. The real
direct integration also rereads the persisted archive through this validator.

This validator supplies no ownership lookup or publication authority. The
owner-scoped reader below derives its binding from authenticated coordinator
records, rather than caller fields or the archive itself. Existing host
descriptor/publication contracts still require legacy aggregate identities; they
cannot consume this direct identity until an explicit versioned contract is
implemented. Existing version-1/2 bytes and public strict validators are unchanged.

Ordinary production dependencies now construct `ownedDirectArtifacts`, a private
reader for authenticated principal call sites. Its only request fields are the
principal public key, session ID and artifact ID. It derives the account and
requires matching real-account ownership, finalized verified action and artifact
rows, exact versions, workspace lineage and validation reference. The immutable
original request index supplies the proposal and original bounded purpose; the
durable artifact index supplies the exact object checksum and original toolchain.
Only an explicitly approved direct toolchain can be read, even when the current
default is a different legacy profile. Conflicting contracts for the same
toolchain refuse access. The approved publication server remains independently
supplied by production configuration.

The reader revalidates the archive and stored scanner/conformance evidence,
and returns explicit direct identity, object and receipt facts. Missing or
inconsistent evidence returns the same unavailable result as a foreign identity.
It needs neither an active worker nor checkpoint decryption keys. Local real-build
integration proves access after actual terminal cleanup and checkpoint/key
deletion, refusal of altered ownership/version/request/object/profile/server
bindings, and zero additional model, worker or object-storage mutations.

The mounted HTTP runtime now uses this reader for explicitly versioned delivery:

- `GET /preview/nip5d-direct-v1/{encoded-session}/{artifact}` returns
  `direct-artifact-delivery-v1`: exact HTML bytes, direct identity, capability
  declarations and the original CLI-generated owner manifest template.
- `GET /artifacts/nip5d-direct-v1/{encoded-session}/{artifact}/index.html`
  returns the exact HTML with a sandbox/no-network CSP. Direct navigation does
  not acquire shell capabilities or signer access.

Encode the entire session ID with `encodeURIComponent`; the artifact component
is the literal `artifact:` followed by its sealed archive checksum. Both routes
require a NIP-98 `Authorization` header for the exact configured HTTPS origin,
canonical path and `GET`. There are no query credentials or cookie credentials.
The event must have empty content, exactly one `u` and one `method` tag, a valid
signature, age below 60 seconds and future skew at most five seconds. The signed
audience is derived from `publicOrigins.preview` or `publicOrigins.artifact`,
never inbound Host/forwarded headers. These origins must be HTTPS origins with
no path prefix, query, fragment or credentials. Proxy-internal HTTP transport
does not change the signed public HTTPS audience.

Browser clients can use the exported signing and verification helpers:

```ts
const request = await createDirectArtifactReadRequest({
  url: previewUrl,
  sign: event => ownerSigner.signEvent(event),
});
const response = await fetch(request);
if (!response.ok) throw new Error('ARTIFACT_NOT_AVAILABLE');
const { delivery, bytes } = await verifyDirectArtifactDelivery(
  await response.json(), { sessionId, artifactId },
);
```

The callback is the owner's existing supported signer. The helper receives no
private key and creates no owner publication event. It omits ambient credentials,
rejects redirects, and checks returned identity, HTML hash/size and manifest
capability semantics. HTTPS and the service's root verification remain the source
of archive/evidence authenticity; the delivery client does not possess or
independently rehash the complete sealed archive.

All responses use no-store/no-referrer headers. OPTIONS only supports browser
preflight on these same routes, with GET/Authorization and no credential mode or
owner lookup. Foreign/missing artifacts share a 404 result; malformed signatures
return 401 before ownership lookup. Read replays within the validity window do
not dispatch generation, signing, publication or new storage mutations.

This is preview **source**, not a capability grant or publication intent. The
mounted static handler now supplies a concrete browser consumer:

- `/static/nip5d-direct-v1/preview-host.js` exports `reviewDirectPreview` and
  `mountDirectPreview`.
- `/static/nip5d-direct-v1/preview-host.json` reports its actual bundle SHA256,
  exact package set and live domains. The bundle is built only from the fixed
  project entrypoint, with environment-variable inlining disabled.

The consumer uses pinned `@kehto/runtime@0.24.1` and the official
`@kehto/shell@0.22.0` CSP/bootstrap, with `@napplet/core` and `@napplet/nap`
`0.32.0`. These are the implementation underlying pinned Paja. Paja's development
signer and local-file aggregate constructor are absent. The shell wrapper's
shared localStorage persistence is also absent: each preview gets a private
ephemeral kernel adapter, bounded to 256 KiB and 512 keys. It creates no owner,
service, provider or development signing key, and installs no relay backend.

```ts
const host = await import(staticOrigin + '/static/nip5d-direct-v1/preview-host.js');
const expected = { sessionId, artifactId };
const review = await host.reviewDirectPreview(delivery, expected);
// Present review and obtain the user's approvedDomains in the trusted host UI.
const preview = await host.mountDirectPreview({
  iframe: freshConnectedIframe,
  source: delivery,
  expected,
  approval: { reviewSha256: review.reviewSha256, domains: approvedDomains },
  signal: lifecycleAbortSignal,
});
// On close, replacement or navigation:
preview.close();
```

Reviewing source grants nothing. Consent binds the exact artifact, archive,
policy, toolchain and declaration. Missing/declined required domains or unknown
grants deny before authored code runs. Current live preview domains are
truthfully limited to `storage`: required `intent` is incompatible; unavailable
optional domains remain absent. This does not broaden or replace authoring
policy. Presentation and consent controls belong to the compatible client.

The host verifies original bytes before official `prepareNappletSrcdoc` injects
CSP/bootstrap into a separate execution copy. It binds trusted manifest identity
to one iframe before execution; source identity never comes from iframe data.
The upstream kernel's historically named `aggregateHash` identity member carries
the current verified content identity, as in its direct pointer API. The CVM
does not compute or advertise a legacy aggregate for this artifact.

Every message requires that exact source window, opaque origin, unchanged
sandbox/source and live frame. Only a source-bound `shell.ready` enables its
immutable granted environment. The upstream kernel handles domain RPCs and ACL;
the host handles only source binding and NAP-SHELL ready/init transport. The
returned promise means the host accepted that handshake, not that arbitrary app
work has finished. Close, abort, iframe replacement/navigation or sandbox
mutation removes authority, listeners, timers, private state and the iframe.

Local proof runs the actually served browser bundle and actual delivered counter
inside the existing bounded, non-root, network-denied worker with real Chromium.
It checks kernel storage, truthful capability presence, opaque-origin network and
direct-storage denial, sibling/wrong-origin/stale-source rejection, declined or
changed consent, quota, fresh-preview state isolation and teardown. This is local
mechanism evidence, not live provider/HTTPS/user-signer certification. Broader
domain support, production client presentation/ContextVM negotiation, explicitly
versioned publication/attestation, owner signing and all live gates remain open.
These handlers/assets have not been deployed or enabled on the private Beta
service; existing legacy strict schemas and records remain unchanged.
