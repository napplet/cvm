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

## Seven-subject preparation and recovery decision (2026-10-31)

The registry is an inventory projection, not an archive factory.  `restore.inventory`
remains read-only: it may only return rows already registered by an explicitly
authorized preparation action.  Preparation runs after the original source has
durably committed and before the protected fresh-restore drill is invoked; it
must bind the selected checkpoint, owner, session, action, retention deadline,
exact object generation and checksum in one registry record.  Ambiguous archive
writes are reconciled by that original operation identity and never replaced by
a second write or a new provider/model/signer dispatch.

Each kind has its own recovered authority. `checkpoint` alone opens the
encrypted checkpoint envelope and may invoke the fenced worker workspace restore.
`sealed_artifact`, `validation_evidence`, and `promotion_evidence` reopen exact
immutable object bytes and verify their source record. `usage_receipt` reopens
the append-only receipt and its original action/operation identity. `owner_event`
and `attestation` reopen their signed publication records and reconcile only the
stored relay operation identities. Non-checkpoint kinds must never be coerced
into a workspace archive or handed to the checkpoint worker restore API.

`promotion_evidence` is the pre-existing artifact validation/promotion original
that made the sealed artifact eligible; it is not the final release-promotion
pointer. Final release promotion is after all eight protected suites, including
restore, so making it a restore prerequisite would be circular. Likewise,
owner-event and attestation preparation may only archive an already committed
user-owned publication record and its original relay operations; recovery never
asks a signer to create a replacement event.

The canonical `checkpoint_crypto_records` primary key is one checkpoint
identity and is sufficient only for the workspace envelope. The six other
archives need a distinct retained-subject crypto/object record with its own
original-operation identity before their source-specific readers can be safely
implemented. Until that authority and its explicit preparation operation exist,
mounted fresh recovery rejects non-checkpoint subjects rather than reporting a
fabricated workspace reattachment.

### Original-source map

Preparation must query the original, recovered production authority; it may
not synthesize a schema-shaped source value. The resolved map is:

| Kind | Original authority | Recovered reattachment |
| --- | --- | --- |
| `checkpoint` | `checkpoint_envelopes` plus canonical checkpoint crypto/object record | fenced worker workspace restore |
| `sealed_artifact` | `ProductionWorkerArtifactStore` original `worker-artifact:*` journal record and its immutable artifact object; SQL `session_artifacts` binds action/session/version | verify artifact contract and retain the original artifact identity |
| `validation_evidence` | finalized action/session-artifact validation-evidence reference and the immutable evidence object | verify the original validation record; no worker restore |
| `usage_receipt` | append-only `usage_receipts` joined to its original action/provider operation | reopen receipt and original-operation reconciliation only |
| `promotion_evidence` | artifact verification/promotion evidence that precedes release finalization | verify eligibility evidence only; never mutate the release pointer |
| `owner_event` | immutable `publication_signed_events` joined through `publication_intents` to the owned artifact/session | verify the stored signed event and observe its original owner-relay operation |
| `attestation` | `publication_records` and its attestation `publication_effect_intents` original operation | verify stored attestation and observe its original relay operation |

The source queries must require the selected checkpoint's owner/session/action
fences and the registry's exact object generation/checksum. A missing original,
ambiguous write, or a source that is only reachable through final release
promotion is a blocking non-pass, never a reason to create a replacement
archive, provider call, payment, relay event, signature, or promotion.

Fresh recovery reconstructs those authorities from the cloned production SQL
pool and uses exact-generation object reads. It does not import the separate
zero-funded development-history migration archive, replay any production ledger,
or construct a new financial/publication operation. Expiry first confirms every
registered subject is due and then tombstones/deletes each exact source object;
retries observe the same lifecycle operation. This closes the registry-only and
checkpoint-for-everything failure modes while retaining the existing 30-day
continuation fence for the one workspace-bearing subject.
