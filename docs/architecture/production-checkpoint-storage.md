# Production checkpoint storage

Apply `migrations/phase-07/003_production_checkpoints.sql` after production
accounting, continuation and operation-journal migrations using the approved
migration bundle. The application role cannot install it. The normal dependency
graph and recovered-database runtime check its columns, restricted privileges and
enabled immutability triggers before opening provider clients or admissions.
Missing or incompatible storage fails startup. This document authorizes no live
migration, cloud operation or deletion.

The additive migration retains existing accounts, sessions, ledger, artifacts and
journal history. It creates checkpoint crypto records, append-only crypto audit,
immutable envelope bindings and owner-bound continuation allocations. Allocation
rows join the checkpoint, session, action, resume command and capacity intent;
they do not queue generation requests. Runtime access is limited to insert/read
and guarded key/envelope destruction transitions. The test accounting realm gets
no grants to this production storage.

## Original operation recovery

Each checkpoint has one random AES-GCM DEK and nonce. A separately mounted KEK
wraps the DEK; SQL contains the wrapped DEK and original ciphertext, never the
KEK or user signing keys. Binding, plaintext, additional-data and ciphertext
hashes prevent a checkpoint ID from being reused for a different request.
Crypto insertion and its audit commit together. Concurrent identical controllers
read the winning material, including its exact key reference and nonce.

New seal journals carry a versioned upload-dispatch fence and a stable original
operation identity derived from the journal operation, request digest and key.
A durable CAS permits one object create; every retry first queries that exact
identity/key/checksum tuple. An acknowledged-loss retry uses only that original
generation without uploading again. Identity-free legacy observations remain
undefined after any multiple-generation same-checksum history; they never adopt
a replacement. A claimed but unobserved write stays reconciliation-required. Legacy journals are retained
byte-for-byte: an unresolved legacy operation cannot create replacement crypto
or dispatch an upload without its original material. Envelope uniqueness races
resolve by reading and comparing the entire original manifest/object binding.

## Expiry and rollback

After the recorded retention deadline, restore refuses before decrypting.
Destruction clears the live wrapped DEK and SQL ciphertext in the same transaction
as the audit entry. Only then may one journaled deletion target the exact object
generation. Lost deletion acknowledgements recover by observation. The envelope
is marked destroyed only after object absence is observed; deletion proof also
requires the live SQL key and ciphertext to be cleared. An uncertain deletion
stays pending and cannot dispatch again.

Back up the schema, service-continuity journal, wrapped key records, envelopes
and original object generations together. Retain access to the original KEK in
the independent secret authority; never include it in workspace archives.
An additive rollback retains these tables and original readers/material. Do not
roll back to an uploader that lacks dispatch fencing while unresolved new
operations exist; quiesce first and retain a compatible recovery reader.
There is no automatic schema contraction or historical data rewrite.

Explicit resume coalesces concurrent copies of the complete owner consent
command. Only a restored result is memoized; funding denials and pending original
observations can be retried after external state changes. Changed consent never
inherits a cached success. Cross-controller idempotency remains in SQL, so retries
reuse the same claim, budget, action, operation, allocation and lease. This does
not authorize a new provider dispatch or implement terminal resumed generation.

The hosted integration test uses real PostgreSQL 17/AES-GCM, a restricted login,
the matching PostgreSQL 17 `pg_dump`/`psql` clients from the service image into a
new database, reapplies only the migration-owned narrow ACL contract, and uses a
disk-backed object protocol fixture. It checks concurrent sealing, upload/delete acknowledgement
loss, unresolved and legacy operations, owner/key denial, guard preflight, audit
rollback and exact expiry deletion. Its advanced test clock does not prove 30
days of elapsed operation. It does not prove live selected-provider/isolated-worker
restore, physical erasure from old backups/WAL, KEK lifecycle, the complete
post-grace resumed action, or any protected release suite. Backup/WAL expiry and
restored-service deadline enforcement remain required live retention evidence.

## Unselected PostgreSQL bytea object candidate (D-141)

`postgres-bytea-object-v1` is a no-effect candidate, not a selected authority.
Migration `019_postgres_bytea_objects.sql` is additive and leaves migrations
007/008/009 and all historic readers byte-for-byte intact. It provides a
security-definer-only object surface to a separate `napplet_production_object`
role/pool; that role has no grant on money, secret or raw object tables. It is
not the accounting role and its bounded chunk transactions never include money
rows.

The existing `ObjectStorePort` remains the compatibility boundary, with an
additive constructed-adapter reconciliation capability and optional
original-operation identity for new callers. A header is
permanent at `(logical key, generation)` and its per-key serializable head
allocates a positive JavaScript-safe generation. A tombstone never reuses an old
physical generation, while a legitimate logical-key recreation receives a new
higher generation. Reads/deletes require exactly key, generation and checksum;
they cannot see or remove a replacement generation. `writing`, `sealed`,
`deleting` and `tombstoned` headers plus bounded ordinal chunks make partial
writes invisible. The adapter copies caller bytes before hashing/awaiting,
seals only after count, length and streamed SHA-256 verification, and retries
only serializable SQL work. A lost commit acknowledgement is held until the
same original identity is observed; it never dispatches an external effect.
Without that identity, any historical same-key/same-checksum ambiguity is held
rather than mapped to the newest generation. A new coordinator journal persists
the constructed adapter's recovery mode. PostgreSQL requires
`original-operation-v1`; legacy key/checksum journals may use only the same
legacy-compatible adapter mode. Unknown capabilities hold before a successor
write and cannot silently downgrade PostgreSQL recovery.

There is intentionally no global 16 MiB cap. The bytea adapter checks its bound
producer's versioned ciphertext and chunk allocation before it claims a SQL
header. New writes have versioned producer
budgets: ordinary checkpoints preserve their existing uncapped archive contract;
retained subjects and workspace/artifact paths retain their 16 MiB caller
bound; migration archives retain 384 KiB × 512 before AES-GCM/tag/base64
overhead. Historical references retain their exact read contract and bypass new
write budgets. Admission p95 under bytea/WAL/backup load, capacity, HA fencing
and one-host recovery remain later selection gates.

### Backup-aware cryptographic expiry

The legacy common mounted KEK remains readable for historical data, but cannot
prove expiry: a day-29 database snapshot with a wrapped DEK can remain readable
at day 59. The candidate `PerObjectFileCheckpointCrypto` preserves the existing
AES-GCM ciphertext, AAD and SQL record format while wrapping each data DEK with
a distinct per-object KEK kept outside PostgreSQL at every declared custody
root. A durable SQL custody state machine records `provisioning → active →
erasing → destroyed`; it commits the identity-bound erasure intent before file
removal and reconciles an unknown commit acknowledgement without deleting a
live key. Its declared-copy inventory has stable root/file identifiers and
checksums.
The fresh PostgreSQL dump/restore test proves restoration before expiry and then
denial when every declared key file is erased, even if the old ciphertext and
wrapped DEK remain in the restored database.

This is a concrete testable lifecycle mechanism, not a claim of HSM or forensic
erasure: filesystem unlink does not erase Borg-packed archives, WAL, replicas,
external key brokers or unlisted copies. A real production candidate is held
until its trusted producer inventories all DB/base-backup/WAL/replica/restore/
broker key copies and either makes every per-object copy independently erasable
or proves an exact backup-exclusion/deadline policy. No configuration boolean
or simulated clock is acceptance evidence. B2 native `fileId` is only the
measured fallback if this candidate fails those gates; no account is created.

## Retained-subject recovery boundary

The restore inventory is a read-only view. Before it can be read, the mounted
production graph performs an explicit receipt-bound preparation of the selected
checkpoint and its exact owner, session, action, and artifact version. The
preparer reads committed production records only: the checkpoint envelope,
verified artifact object and validation record, settled usage receipt, finalized
artifact promotion record, and a completed user-owned publication's owner event
and attestation observation. It seals the six non-workspace records under
distinct server-derived custody identities and records all seven exact object
generations in the append-only durability registry. The source identity stays
the identity of the original record; it is never replaced by the derived key ID.

Only `checkpoint` may restore a worker workspace. The other six kinds decrypt
their exact retained bytes and reattach or observe their original record; a
missing or ambiguous record is reconciliation-pending, not an opportunity to
call a model, signer, relay, worker, wallet, or publication provider. Artifact
promotion evidence is the verified artifact's original validation/promotion
record, not a post-suite release-promotion result. Owner and attestation inputs
are accepted only from an already completed user-owned publication.

At expiry, the fresh recovery runtime deletes each non-workspace ciphertext by
its exact generation and destroys its corresponding server custody key before
the checkpoint workspace is destroyed. Any missing binding or uncertain delete
blocks instead of producing replacement material. This remains a protected-live
operation: the opt-in fresh-PostgreSQL durability CI checks only the production
SQL/crypto/fresh-instance mechanism and does not certify a selected provider or
a release suite.
