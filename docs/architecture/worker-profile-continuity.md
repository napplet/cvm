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

- Preserve access to original topology-scoped runtime, worker, job and request
  journals. The current runtime reconstructs every scope from the current
  topology hash; changing configuration can otherwise hide history.
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
