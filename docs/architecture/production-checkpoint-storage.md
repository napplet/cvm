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

New seal journals carry a versioned upload-dispatch fence. A durable CAS permits
one object create; every retry first queries the original object key/checksum.
An acknowledged-loss retry uses that object without uploading again. A claimed
but unobserved write stays reconciliation-required. Legacy journals are retained
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

The local integration test uses real PostgreSQL/AES-GCM, a restricted login,
actual pg_dump/psql into a new database, and a disk-backed object protocol fixture
behind the GCS adapter. It checks concurrent sealing, upload/delete acknowledgement
loss, unresolved and legacy operations, owner/key denial, guard preflight, audit
rollback and exact expiry deletion. Its advanced test clock does not prove 30
days of elapsed operation. It does not prove live GCS/Cloud SQL/isolated-worker
restore, physical erasure from old backups/WAL, KEK lifecycle, the complete
post-grace resumed action, or any protected release suite. Backup/WAL expiry and
restored-service deadline enforcement remain required live retention evidence.
