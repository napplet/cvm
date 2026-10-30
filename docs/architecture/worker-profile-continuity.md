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
