# Initial admitted-command checkpoints

Storage compatibility proposal: [issue53](https://github.com/napplet/cvm/issues/53).

An initial funding pause has an admitted session and cap hold, but no paid
action, provider operation, source request or verified workspace. Exporting it
as a workspace checkpoint cannot succeed honestly. This expansion saves its
exact bounded command through the real encrypted checkpoint coordinator and
releases the original idle capacity after the checkpoint commits.

At mainline `b6775e1`, the pending executor is present but this initial producer
is missing. ContextVM SDK0.13.10 and MCP SDK1.30.0 remain pinned. Keeping the idle
worker indefinitely cannot satisfy the ten-minute release and durable-resume
contract. The existing workspace path requires a real prior build.

For synthetic `session:example`, the previous deadline result is
`checkpoint_retryable / CHECKPOINT_FENCE_RETRYABLE`. With this expansion a
successful seal/commit/release returns `checkpointed / CHECKPOINT_COMMITTED`
and a stable `pending-checkpoint:` identity. Uncertain release remains retryable
and its committed cleanup scan observes the original resource. These are
internal lifecycle results; no signed public tool request changes.

## Format and authority

Existing `checkpoint-manifest-v1` workspace bytes stay unchanged. The new
`checkpoint-manifest-v2` has `payloadKind: pending_command` and exactly the
inventory `admission_state`, `compatibility_metadata`, `pending_action`. All
prior action/session/artifact/workspace versions are zero. Its workspace lineage
is the identity for a future build, not evidence that a workspace exists.
Its pending action/operation identifiers identify coordinator state; neither
claims a paid provider operation or fabricated build receipt.

Before sealing, restricted SQL must prove the exact owner/session/pause/lease,
checkpointing state, accepted admission, zero verified version/spend and no
metered action. The archive contains the bounded original command plus its
pending intent, excluding the live envelope. A durable `commandSha256` identifies
every original command field. The live AES-GCM envelope authenticates the same
plaintext hash and all existing semantic bindings. Hash metadata is not a key
or a substitute for owner authorization.

The actual mounted-KEK coordinator encrypts the archive under its own durable
per-checkpoint DEK. SQL stores ciphertext, never the archive's plaintext command;
the object backend receives ciphertext. Nonces, ciphertext and exact object
generation survive retries. Mutable archive buffers are cleared after sealing
or decoding. No worker export, fake artifact or empty workspace restore occurs.

## Retention and resume

The original seal journal fixes the checkpoint timestamp and its full 30-day
deadline. SQL, manifest and checkpoint DEK use that same anchor; a later retry
does not extend it. The earlier live-command envelope can expire independently.
During the checkpoint window, the server-owned exact loader decrypts the outer
archive and verifies its complete pending identity and command hash against SQL.
This permits exact continuation after live-envelope expiry without extending
that envelope's key authority or accepting caller-supplied prompts.

An installed consumer is required before financial effects. It validates the
command and original profile/card/toolchain, claims one resume budget/action,
allocates its original capacity intent, and records coordinator material restore.
Pending-only material never enters the worker workspace-restore interface.
Normal execution later persists its new worker request against the actual resume
allocation. Existing workspace restore keeps its separate path.

The production constructor now installs the mounted command protector, initial
producer and bounded release recovery. It still does not install the generation
executor: retained USD/FX/provider context and revision lineage remain required.
An old or unsupported pending command cannot trigger a paid fallback.

## Release and crash recovery

The accepted funded hold stays reserved for explicit continuation. Only the
original capacity linked to the owned admission is released. The existing
provider client owns original termination identity and ambiguity handling.
Confirmed release appends its immutable outbox evidence; a bounded scan of
already committed pending checkpoints recovers a crash after commit or a lost
termination acknowledgement. It cannot choose another worker or create work.

## Expansion, old readers and rollback

Apply `migrations/phase-07/006_production_pending_checkpoints.sql` before the
checked production runtime. It expands the existing envelope format constraint,
validates retained rows and changes no data, ciphertext, grants or audit history.
It is repeatable. Startup and the producer check the validated expansion before
provider/object effects. New runtime reads both formats. Old strict readers can
read retained v1 but reject v2; upgrade readers before enabling the writer.
Quiesce old writers for rollout, install the additive migration, and replace all
readers/writers with compatible revisions before admitting new work. The new
production constructor installs its writer; a mixed rollout cannot assume an
independent reader-only feature flag.

Old pre-hash live envelopes still decrypt with their original AAD and bytes.
They cannot authorize retained-command recovery through a missing exact hash.
Do not invent a command/hash for legacy incomplete pauses. The separate
development pre-admission pending format and user-signed tool requests stay
unchanged. This is a project storage/reader expansion, not a Nostr or CEP change.

Rollback retains the expanded constraint, v2 objects, ciphertext and mounted
key access. Use a compatible reader for newly written pauses. Never drop the
column/data, down-convert v2 into a fictitious workspace or extend a deadline
to make a failed recovery pass.

## Local evidence and remaining gates

Restricted PostgreSQL and the actual mounted-KEK/checkpoint/deadline code cover
a natural 8-of-10 test-sat pause, explicit top-up/cap, failures before and after
checkpoint commit, unchanged ciphertext/object identity across retry, lost
capacity-release acknowledgement and exact original release. A real local
`pg_dump`/`psql` restore into a fresh database reads both v1 and v2 with the
restricted role. Old v1 bytes survive the repeat migration. A golden pre-hash
envelope from revision `eda4529` decrypts unchanged.

The clock advances past live-envelope expiry while the checkpoint remains
valid. One resumed action then reconciles lost provider and terminal SQL commit
acknowledgements to one budget, operation, build and charge, with zero workspace
exports/restores. These are explicit local rail/capacity/object/model/build
fixtures and simulated time, not elapsed retention, live GCS or isolated-worker
certification. Command-key erasure, claimed-checkpoint cleanup, revision lineage,
original USD/FX authority, within-grace wake and all live release gates remain.
