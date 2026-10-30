# Production generation funding and pricing

An accepted admission already holds funded sats for its approved session cap.
Account `availableBalance` excludes every hold. Production continuation therefore
checks unheld balance plus this admission's own remaining hold before claiming an
action budget. It does not require the customer to fund the same hold twice or
count another admission's held funds. Pause, verified-credit wake and explicit
resume use the same opt-in rule. Generic legacy callers keep their existing
policy; production explicitly selects the own-hold policy.

This affordability check grants no spending authority. The serializable action
budget reservation still enforces the admission cap and outstanding reservations
before a provider claim. A competing authorized budget can reject a new action
without a model dispatch. Actual receipt settlement reduces both settled balance
and the selected hold; terminal replay reads the original result. Shortfalls in
the approved cap still require explicit approval and cannot consume another hold.

## Admission COMMIT uncertainty

The PostgreSQL money transaction distinguishes a failed COMMIT acknowledgment
from a known pre-commit failure. `FundingCommitOutcomeUnknownError` preserves
the original message/cause and carries no new public or persisted fields. Once
COMMIT was attempted, an error remains uncertain unless PostgreSQL explicitly
reported a serialization or deadlock abort. An uncertain COMMIT is not retried
inside that transaction loop, and a later ROLLBACK attempt is not proof that
the earlier COMMIT failed.

Before compensating a reservation, admission reads the original account and
idempotency command. An accepted result must match its owner, capacity and
complete command fingerprint. A matching committed result is recovered without
another cap hold or native release. Substituted evidence refuses without granting
release authority. If readback is unavailable, or COMMIT is uncertain and no
result is visible, the caller receives `reconciliation_pending`; the original
capacity and funds are preserved. A later authenticated retry queries the same
durable original. Known pre-commit failures with no recorded acceptance retain
the existing compensation path.

The actual restricted PostgreSQL proof faults before and after real hold COMMIT,
fails readback, recreates admission services and checks one hold/result/reservation
with no native release for uncertain or committed work. Known rollback still
releases unused capacity. Unit tests reject owner/capacity/fingerprint substitution.
Rails and worker observations in these tests are explicit local fixtures; this is
not live funding or release certification evidence.

No migration or saved identity changes. Deploy the SQL outcome classifier and
admission consumer together; rollback must retain uncertainty handling.
Abandoned-capacity discovery and proof of unused admission/action ownership
remain required. A pending result or absent
readback alone never authorizes refund or abandonment of a paid action.

## Admission versus compensation

Acceptance and compensation serialize on the same owned capacity intent. Before
creating a hold, SQL acceptance locks an existing matching intent with a no-op
write and requires its original reference and `available` state. The write also
invalidates an older SERIALIZABLE snapshot that waited on this row. Trusted
legacy FundingService callers with no intent retain their existing path; the
production ContextVM admission path always creates its intent first.

`claimCapacityCompensation` locks the intent and reads any original accepted
command in the same transaction. If acceptance won, it returns that exact result
and grants no cleanup. Otherwise it records the existing `refused` state and
original capacity reference. Only the successful first claim authorizes native
release. Terminal refused/released states cannot be revived by a delayed readiness
response, and the original capacity reference cannot be replaced. The memory,
reference and SQL authorities enforce these same rules.

Compensation cannot proceed without an acknowledged durable fence. A SQL outage
or lost claim COMMIT leaves the worker pending. Fresh retries never dispatch a
release from a previous claim; they use `ReadyCapacityPort.observeRelease` to
observe original termination. The production capacity router forwards this to
the original provider, even after the selected default changes. Confirmed native
termination alone permits `released`. Older ports without this optional observer
remain pending; ordinary readiness refusal is not termination proof. A lost claim
acknowledgment may therefore require observation through the worker's bounded
provider lifetime rather than another cleanup dispatch.

Restricted PostgreSQL tests hold acceptance in flight while another controller
attempts compensation, and return stale readiness after compensation wins. They
prove one original hold with no release in the first case and no hold with one
release in the second. Lost claim, native-release and finalization acknowledgments,
fresh service instances, immutable terminal state/reference and query-only retry
are also tested. These are local mechanism tests, not live release evidence.

No migration, new state variant, public schema or saved identity is introduced.
Deploy matching acceptance writers, compensation readers and native observers
together; drain older writers before relying on the fence. Rollback must retain
the fence-aware code and both original journal histories. This is not authority
to refund or abandon an accepted or unknown paid action. Full funded native
CREATE certification remains open.

## Bounded unused-capacity observation

The normal mounted runtime polls ordinary unaccepted admission intents every
30 seconds. Each scan examines at most 32 rows and checks a 30-second budget
between observations. Native requests retain their transport deadlines. One
instance coalesces overlapping scans; close stops new work and awaits an active
observation before closing SQL. A versioned journal cursor preserves keyset
progress across restarts and wraps after a short final page. Competing replicas
may repeat queries; cursor compare-and-set prevents overwriting newer progress.

Discovery selects production-real owners without an original funding command,
admission, cap hold, action budget or metered action. It only recognizes the
original account/key admission namespace, excluding continuation and priced-resume
capacity. The scanner resolves the exact capacity and native operation, then
uses the retained approved executable to observe termination. Missing approval,
substituted metadata, unknown native state and an absent resource without a
previously bound native ID remain pending. It cannot CREATE, execute a job,
request termination, credit, refund or release a cap hold.

A confirmed native termination creates immutable
`admission-capacity-termination-v1` evidence in the existing operation journal.
It binds the account, intent fingerprint, original capacity/session binding,
deadline and exact native identity. Finalization locks the same SQL intent as
acceptance, rechecks every financial ownership predicate, and only then records
the existing `released` state and one `admission_capacity_observed_terminated`
outbox event in the same transaction. If acceptance wins during observation, its
hold and intent remain intact. The event is operational audit evidence; it
authorizes no payment or redispatch. Existing event-specific readers ignore this
additive kind. A lost proof/finalization acknowledgment is recovered from the
original durable records without another native effect.

No migration, public field or new capacity state is required. Startup checks the
required existing tables and each runtime privilege before starting the relay.
Deploy with the matching acceptance/compensation fence and retained-profile
readers. Rollback must preserve the new versioned cursor/proof entries and outbox
history; an older binary can leave this observer disabled while retaining the
fence. This observer does not recover the initial native claim/CREATE dispatch
gap, abandon paid actions or discover continuation-specific cleanup.

Restricted PostgreSQL tests exercise cursor continuation beyond 32 candidates,
retained-profile refusal/selection, metadata substitution, unknown/missing-ID
observations, acceptance during lookup, concurrent scanners, lost proof and
finalization COMMIT acknowledgments, time bounds and awaited shutdown. Local
provider and rail fixtures prove the mechanism, not live isolation or release
certification. Full funded native CREATE, live lifetime cleanup and protected
release suites still require their own evidence.

## Immutable pricing catalog

Runtime construction validates the mounted captured Vertex quote, its source
bytes/hash/freshness and FX provenance, then registers the selected model profile
and price card in restricted production SQL before starting the relay. Neither a
development fixture nor synthetic ChatGPT pricing can enter this registration.
The existing price-card table's `unit='sat'` denotes the ledger unit; the normalized
provider card retains its USD-micros currency and exact FX source for settlement.

Apply `migrations/phase-07/002_production_pricing_catalog.sql` after production
accounting through the approved migration bundle. It preserves existing rows,
revokes runtime updates/deletion and guards both version tables against mutation.
Startup refuses a catalog with runtime update privileges. Capture the new schema
and source digests in candidate/migration material before final authorization;
this document does not authorize a live migration or replace controller gates.

Registration is insert-only and serializable. Concurrent identical starts replay
one version. Reusing a version ID with different canonical content refuses and
rolls back; it never updates historical rates. New Vertex cards identify the full
pricing policy, source/FX provenance, validity, limits and profile/deadline context.
Mounted model profile IDs also identify their complete normalized policy. Renewing
or changing a snapshot produces new versions while retaining previous rows.
Unknown old model operations must still use their original pricing context; these
new IDs do not permit redispatch or silently reprice an interrupted operation.

## Operational model and source persistence

The Vertex client accepts the generation core's colon-delimited normal/resume
operation IDs unchanged. Invalid or oversized IDs fail before dispatch. Retained
Vertex receipts represent uncached input and cached input separately; replay
prices those dimensions once, including a completely cached request. It never
subtracts cached input a second time or issues another model POST to repair a
receipt mismatch.

New normal operations pass the selected profile's input ceiling into the Vertex
client. It bounds the UTF-8 bytes of the complete encoded recovery input and
system text before a fresh provider journal claim or POST. Completion/replay
validate total input against that retained bound. A known local bound rejection
finalizes without a model call or debit; ambiguous transport outcomes stay unknown.
The field is optional only for historical journals and existing certification
callers, which retain their prior global bound. Never rewrite old requests or
redispatch them with a newly selected bound.

Apply `migrations/phase-07/004_production_source_proposals.sql` after the reviewed
checkpoint migration through the approved bundle. This additive table binds
source to the existing account/session/action, expected version, fingerprint and
provider operation. Runtime has insert/read privileges only; an immutable trigger
rejects edits/deletion. The startup graph checks the schema and grants before
provider construction, so a missing source store cannot be discovered after a
paid completion. No live migration is authorized here.

Identical source writes use serializable insert-and-compare replay with bounded
transaction retry. They need no `FOR UPDATE` on immutable rows and no runtime
update grant. Conflicting source never replaces an original; foreign-owner reads
return no proposal. Rollback preserves source rows and a compatible reader.

The composed local PostgreSQL test uses actual production Vertex HTTP encoding,
operation journals, gateway, source store, pricing/FX settlement and metered core.
Its provider responses, funding and worker are explicit protocol fixtures. It
proves one model POST, source persistence, cached-usage settlement and terminal
replay under restricted SQL; it does not prove a real paid API call, actual rails,
isolated build or any protected release suite. Historical pricing selection and
full pending-action execution still require
their own composed proof before live authorization.

## Proof boundaries and remaining continuity work

The restricted-PostgreSQL regression uses explicit model/worker/credit protocol
fixtures. It proves a fully held funded start, exact test receipt settlement,
new-controller replay, separation of another hold, budget contention, insert-only
pricing replay/conflict and immutable history. It is not a real paid-model,
Lightning/Cashu, isolated worker or protected release-suite result.

The SQL pause implementation already creates an initial session row; an earlier
missing-session suspicion was disproved by reproduction. Its foreign keys instead
require the pricing catalog registration now performed at startup.

Full post-grace continuation remains unfinished. The deadline path's synthetic
action binding must resolve the real original workspace/request, the pending
command must survive in durable protected material, and an explicit resume must
execute and settle its approved pending action through a real producer. Original
profile/pricing selection must precede budget or allocation. The additive
[checkpoint storage schema](production-checkpoint-storage.md) now has local
encryption and fresh-SQL restore proof. Live encrypted storage/fresh restore,
cap-extension consent, ten-minute
live grace and the 30-day window still need composed production proof. A restored
workspace alone is not a completed generation or release certification.
