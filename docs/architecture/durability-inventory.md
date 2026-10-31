# Durability inventory and control-image preparation

The protected restore service reads seven retained subjects from the original
checkpoint, session and owner. The registry records exact object keys,
generations, checksums and source identities. It does not select a latest action
or make observations about object availability, deletion or production readiness.

`migrations/phase-07/014_production_durability_subjects.sql` is an append-only
schema expansion after the existing production accounting and journal schema.
Canonical `003_production_checkpoints.sql` remains the authority for encryption,
envelopes, audit and continuation worker allocation tables.

The durability table accepts the historical private `007_durability_subjects.sql`
layout without rewriting rows. Restricted controllers receive SELECT, INSERT
and lifecycle-column UPDATE only. SQL guards preserve identity and permit
retained-to-tombstoned-to-deleted or retained-to-deleted transitions. Exact
deletion-marker retries read the existing outcome; they cannot restore a deleted
record or change its object generation. Fresh registrations must start retained;
historical terminal rows remain readable during a non-rewriting expansion. The
restore service consumes the same scoped registry through its already realm-bound
pool.

Historical private `008_checkpoint_crypto.sql` and
`009_continuation_worker_allocations.sql` describe older incompatible layouts.
They are not active canonical migrations and must not be replayed to provision
this schema. Their files and histories remain preserved. An actual legacy
database needs measured schema inventory and its own matching migration/restore
preparation; matching table names alone do not establish compatibility.

Apply the expansion only through the exact authorized migration bundle, after
backup, fresh restoration and quiescing requirements pass. Rollback disables new
consumers while retaining tables, immutable records and compatible readers for
the resume window. There is no destructive down migration.

## Local verification

The opt-in PostgreSQL test exercises fresh canonical schema, the historical
durability-table expansion, owner/session/checkpoint separation, SQL mutation
denial, deletion-marker replay and a new process reading a fresh database clone.
It also reruns the existing restricted checkpoint encryption/restore/erasure
proof. These are local mechanism tests, with fixture object/provider ports and
no production-release evidence.

The production control Dockerfile includes frozen dependencies, manifests,
canonical SQL and both digest-checked vendored CLI helper sets. Application files
remain root-owned; the runtime uses UID65532 and a private temporary directory.
Build and inspect an unselected local image with:

```sh
docker build -f infra/production/Dockerfile -t cvm-control-proof:local .
image_id="$(docker image inspect --format '{{.Id}}' cvm-control-proof:local)"
bun scripts/test-production-control-image.ts "$image_id"
```

The probe runs without network, capabilities or authority mounts, checks helper
loading and source hashes, refuses startup without the fixed configuration, and
confirms its containers are absent afterward. It certifies neither a worker
boundary nor a functioning production deployment.

Actual preparation of all seven owned production subjects, provider-authorized
restore drills, exact topology/candidate material, release certification and
bounded final authorization remain required before deployment.
