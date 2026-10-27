# Production provider billing

Production generation is Vertex AI **Gemini 3.8 Flash** at the `global`
location. The development ChatGPT OAuth integration remains a
`development-test` path and is not a construction input for the production
adapter, production price card, or settlement.

## Authoritative sources and capture

The production reader captures bytes, SHA-256, observed time, freshness, model,
location, currency, unit, and effective period from the current official
[Gemini Enterprise pricing page](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing).
Its October 27, 2026 contract accepts only the global Gemini 3.8 Flash table
effective through December 31, 2026: gross USD $0.75 / million input tokens,
$0.075 / million cached input tokens, and $3.75 / million output plus thought
tokens. Promotional credits are recorded separately by a future provider
receipt; they are never subtracted from the authorization price or interpreted
as a customer-funded balance.

The reader rejects redirects, a changed model/location/effective-period table,
missing cached/output/thought columns, stale observations, and bodies outside
its bounded request/body deadline. Infrastructure quotes use the paginated
official Cloud Billing catalog with exact SKU, region, currency, and unit
matches. Worker authorization uses twenty billable minutes (ten active plus ten
continuity-grace minutes): Modal must be quoted at its hard 2 CPU / 2 GiB
ceiling, while Fly is 1 CPU / 1 GiB. Project-owned certification ceilings are
maximum-spend policy only and must never appear as a vendor source or price line.

## Request identity and receipt recovery

The adapter writes the immutable operation ID, request digest, model, global
location, source-priced snapshot, and a controller nonce **before** issuing the
paid request. It uses stored Interactions with the documented `GET` and bounded
paginated `LIST` APIs. A lost create response is never resent: recovery searches
at most three 500-entry pages for the exact nonce/model, then GETs the selected
interaction. Missing, duplicate, mismatched, pending, failed, or malformed
results remain unknown and require operator reconciliation.

This is deliberately a bounded inference, not an idempotency guarantee. The
[Interactions API](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api)
is Preview and documents no create idempotency key. Protected fault evidence is
required before production use; this implementation does not claim that an
absent list result proves zero usage.

Completed receipts preserve gross input (total less cached), cached input,
visible output, and thought tokens. Tool-use tokens are refused because this
price contract has no tool-use quote. The calculation uses integer USD micros
and upward rounding per priced category; a receipt cannot overwrite the
request-bound price snapshot.

## USD to sat settlement

The model provider receipt is USD. Settlement must additionally pin a fresh,
source-attributed USD/sat rational quote and bind its URL, bytes digest, observed
time, effective time, and freshness to the same operation. Conversion rounds up
to sats. `src/currency/btc-usd.ts` is display-only (and permits last-known
values), so it is expressly prohibited from authorization or debit.

No source snapshot, price-card provenance, bounded request envelope, or exact
provider receipt may be replaced by a development fixture, a free-tier
assumption, a synthetic sat rate, or an inferred project ceiling.
