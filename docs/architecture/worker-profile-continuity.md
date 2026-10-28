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
- Resolve original worker/job clients through server-approved retained execution
  contexts, including original provider app/region and artifact contract. The
  bridge and job client currently accept one configured toolchain.
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
