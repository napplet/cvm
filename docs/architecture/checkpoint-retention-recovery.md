# Interrupted checkpoint retention deletion

Tracked in [issue57](https://github.com/napplet/cvm/issues/57).

The retention reconciler tombstones a due checkpoint before deleting its key and
exact object generation. Production discovery previously selected only
`resume_required` rows. If deletion failed or its acknowledgement was lost, the
committed row was already `expired` and a restarted controller never selected it
again. The retry-capable deletion code alone could not close that gap.

Production discovery now selects due `resume_required` and `expired` originals.
It excludes a row only when a durable `deleted` outcome names that checkpoint
and its exact immutable object generation. Another generation's evidence cannot
hide it. Completed originals leave the bounded oldest-first 100-row batch, so
already completed rows do not occupy every scan slot. The reader uses the
restricted production accounting realm.

Discovery supplies hints to the existing transaction and checkpoint coordinator.
The store still owns the claim-versus-expiry election. The coordinator still
owns key erasure, original deletion identity, dispatch claims and exact-generation
observation. A lost delete acknowledgement reconciles the original; it never
blindly reissues deletion. No deadline, authorization, schema or stored identity
changes. Checkpoints claimed before expiry retain their existing behavior.

The regression test reproduces the old SQL omission using actual restricted
PostgreSQL and the real deadline/checkpoint/crypto/GCS adapter composition. A
provider protocol fixture deletes the ciphertext and loses its acknowledgement.
A fresh reader and reconciler discover the expired original, observe completion,
and record deletion with one delete call and one key-erasure audit. Future
checkpoints are absent from discovery, another generation's deletion does not
hide a due original, and completion removes it from later scans.

The object backend and clock are explicit fixtures. This is not live cloud,
physical media or 30-day elapsed-retention evidence. Claimed archive disposal,
live-command wrapped-key/ciphertext erasure, backup retention and protected
release certification remain separate unfinished work.

Deploy compatible readers before relying on interrupted deletion recovery. No
migration is needed. Rollback preserves all records and audit evidence; the old
scanner can leave interrupted expired rows undiscovered until a compatible
controller resumes their original deletion operations.
