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
admission consumer together; rollback must retain uncertainty handling. Broader
cross-process compensation fencing, abandoned-capacity discovery and proof of
unused admission/action ownership remain required. A pending result or absent
readback alone never authorizes refund or abandonment of a paid action.

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
