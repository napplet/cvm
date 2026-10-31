# 07-66 PostgreSQL Immutable Object Candidate Handoff

**Status:** implementation preparation only; unselected, no live authority or effects.

## Compatibility map

- `ObjectStorePort` preserves its creation return and generation-pinned read/delete contract. New callers may supply an additive optional `originalOperationIdentity`; `observeExactByKey` remains reconciliation-only and must not expose a latest/list capability.
- Existing `GcsObjectStoreAdapter` and `DeterministicObjectStore` remain the legacy/test readers. This candidate neither renames nor emulates their transport. `ProductionCheckpointCoordinator` gains only typed optional crypto dependency injection; its default mounted-KEK construction, journal, pool, and all existing callers remain byte-for-byte behaviour-compatible.
- `ProductionCheckpointCoordinator` persists original ciphertext material before object creation and binds its immutable object reference to `checkpoint_envelopes`. The new adapter will receive ciphertext bytes through the same port, with a defensive synchronous copy before hashing or an async boundary.
- Phase-07 migrations currently end at `018`; `007`, `008`, and `009` remain byte-for-byte historical inputs. `019_postgres_bytea_objects.sql` is additive only.

## Candidate SQL model and transitions

`immutable_object_generations` is the permanent identity ledger, keyed by `(object_key, generation)`; generation is a positive JavaScript-safe integer and is never reused. A per-key head counter allocates the next generation under a serializable claim. This permits a valid new higher-generation recreation after a tombstoned generation while ensuring an old reference can never reach replacement bytes (no ABA). The header records original-operation identity, checksum, byte count, chunk count, retention deadline and state `writing|sealed|deleting|tombstoned`; chunks are keyed by `(object_key, generation, ordinal)`.

Only a sealed header with exact stored count/length/SHA is readable. Same key + same bytes reconciles only to its sealed original-operation identity; a no-identity observation is undefined if *any* historical matching checksum exists beyond one generation, including `writing`, `deleting` or `tombstoned` rows. Same key + changed bytes conflicts while that immutable generation is current. A deletion claim matches exactly key/generation/checksum, moves only that row to `deleting`, deletes bounded chunks, and permanently tombstones that generation. A lost commit acknowledgement is reconciled by the original SQL identity rather than replaying non-SQL effects.

The application role cannot mutate raw headers/chunks. The adapter accepts only a dedicated object pool/role, must verify the connected role and production schema, and is deliberately separate from the accounting pool so object chunk transactions cannot encompass money rows.

## Quotas and retention boundary

There is no universal 16 MiB limit. New-write budgets must be per producer and versioned: ordinary checkpoint archives retain their current uncapped contract; retained subjects and workspace/artifact paths retain their existing 16 MiB limits; migration archives remain 384 KiB × 512 plus AES-GCM/base64 overhead. Historical reads bypass new-write quotas while retaining exact reference validation.

SQL row deletion or expiry under the existing mounted/common KEK is not an expiry proof: a day-29 backup can remain decryptable on day 59. The candidate therefore remains held unless the retention contract inventories every live DB/base-backup/WAL/replica/restore/broker key copy and demonstrates independently erasable per-object key material (or an exact backup-exclusion/deadline mechanism). Filesystem unlink and a mocked clock are not acceptance evidence. The later selection gate includes actual PG17 restore, all-copy key-custody evidence, WAL/backup I/O, p95 admission impact, host capacity, HA fencing, and one-host failure proof.

## Narrow custody implementation effect

`PerObjectFileCheckpointCrypto` preserves the existing v1 SQL record, AES-GCM
AAD, ciphertext and wrapped-DEK formats. It generates a data DEK as before, but
wraps it with a unique per-checkpoint KEK copied atomically to every declared
absolute custody root. PostgreSQL, base backups, WAL and restores contain the
wrapped DEK/ciphertext but not that KEK. A durable SQL custody record transitions
`provisioning → active → erasing → destroyed`: it fences concurrent provisioning,
keeps all key copies after an unknown commit acknowledgement, records erasure
intent before any unlink, and permits a restart to finish an interrupted erase.
The associated `FileObjectKeyCustody` produces root/file identifiers and key
checksums for lifecycle receipts, verifies all declared copies agree on restore,
and removes all declared copies only after the durable erasure intent. It exports
no key material.

The hosted PG17 test retains a real SQL dump containing old ciphertext/wrapped-DEK
and declares both live and key-backup file roots: it restores successfully
before expiry, then fails after every declared key file is absent. This proves
only the declared test scope. Borg-packed, replica, WAL, broker, HSM, or other
unlisted copies are unknown/held; unlink is not forensic erasure and this is not
a production selection, broker, microservice, or custody certification.

## Forward / rollback

Forward: expand with migration 019 → run fresh PG17 SQL race/restore tests through the restricted role → wire only a candidate construction in a later explicitly owned composition task after all gates. Rollback before wiring is simply to stop using the candidate; the append-only tables/tombstones remain for audit. No migration contracts existing data, changes legacy readers, or selects this candidate.
