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
isolated build or any protected release suite. Profile-specific input bounds,
historical pricing selection and full pending-action execution still require
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
