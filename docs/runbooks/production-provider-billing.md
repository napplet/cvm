# Production provider billing

Production generation is Vertex AI **Gemini 4 Argon** at the `global`
location. The development ChatGPT OAuth integration remains a
`development-test` path and is not a construction input for the production
adapter, production price card, or settlement.

## Authoritative sources and capture

The production reader captures bytes, SHA-256, observed time, freshness, model,
location, currency, unit, and effective period from the current official
[Model Garden pricing page](https://cloud.google.com/model-garden/pricing).
Historical receipts retain their original source URL and byte digest; a current
reader source update never rewrites or reclassifies those immutable records.
Its October 27, 2026 contract accepts only the global Gemini 4 Argon source
table: gross USD $4 / million input tokens, $0.20 / million cached-input
tokens, and $20 / million combined output-plus-thought tokens. The advertised
50% promotion is a credit back on net spend, not a lower gross provider charge
or customer-funded balance. The reader binds both the promotion/effective
period and standard gross table; a request outside the gross table's effective
period is refused rather than priced from a project ceiling.

The reader rejects redirects, a changed model/location/effective-period table,
missing cached/output/thought columns, stale observations, and bodies outside
its bounded request/body deadline. Infrastructure quotes use the authenticated,
paginated official Cloud Billing catalog with exact SKU, region, currency, and
unit matches. CEP-8 Lightning and Cashu are funding capital plus separately
contracted provider fees, not Cloud Billing SKUs, and are never sent to that
catalog. Worker authorization uses twenty billable minutes (ten active plus ten
continuity-grace minutes): Modal must be quoted at its hard 2 CPU / 2 GiB
ceiling, while Fly is 1 CPU / 1 GiB. Project-owned certification ceilings are
maximum-spend policy only and must never appear as a vendor source or price line.

## Certification authority workspace boundary

Release-certification authority records live on a coordinator-private volume.
The coordinator runs under its own UID; the workspace and authority directories
are owned by that UID and are not group/world writable (new directories use
`0700`, new authority files `0600`). The worker Sandbox/Fly runtime never
mounts that volume and runs under a separate UID with no coordinator filesystem
write path. This OS boundary is what makes the controller's checked pathname
operations safe from untrusted generated code: code sharing the coordinator UID
is part of the coordinator TCB and already has equivalent authority over its
credentials and deployment inputs.

Startup rejects an existing workspace, ancestor, or authority child that does
not satisfy that ownership/permission boundary; it never repairs a pre-existing
unsafe path. Root-owned non-writable ancestors are accepted, and only the
platform's root-owned sticky `/tmp` forms are recognized as a constrained
ancestor exception. Historical authority records remain immutable and are not
rewritten merely to normalize their read permissions.

### Modal Sandbox source selection

The Modal reader binds a quote only to the uniquely rendered **Modal Sandbox
pricing** section of [Modal's public pricing page](https://modal.com/pricing).
It reads the exact non-preemptible CPU and memory per-second values in that
section, retains the complete bounded response bytes and digest, and rounds the
derived USD micros upward. It must reject a missing, duplicate, malformed, or
ambiguous Sandbox section or rate; a general Function/compute rate is never a
fallback. In particular, the page's descriptive 3x relationship is not a
calculation input: authorization uses the explicitly rendered Sandbox numbers.

This source is an authorization quote, not an invoice or actual-usage receipt.
[Modal's Sandbox resource documentation](https://modal.com/docs/guide/sandbox-resources)
defines CPU as physical cores (two vCPUs each) and billing as the greater of
requested or actual resources. Provider receipts and the broader resource,
region, and surcharge reconciliation remain required before finalization.

### Actual-cost evidence is deliberately unavailable

The current generic provider port has no authenticated provider-report
transport. It therefore rejects every supplied `costObservation`, including a
syntactically valid zero-cost report and any caller-claimed raw-report digest.
New operations retain `billingStatus: unknown` and their full approved
reservation; completion of the original resource is not billing completion.
Persisted report-shaped JSON is likewise not finalization evidence. A future
provider-specific implementation must bind immutable provider-returned report
bytes (or a verifiable signed receipt) to the authenticated account and
original operation before actual cost can be observed. No local "trusted"
injection or self-report configuration substitutes for that transport.

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

Completed and incomplete receipts preserve gross input (total less cached),
cached input, visible output, and thought tokens. An incomplete response at a
combined output/thought cap has no artifact but still has immutable billed USD
evidence. Tool-use tokens are refused because this price contract has no
tool-use quote. The calculation uses integer USD micros and upward rounding per
priced category; a receipt cannot overwrite the request-bound price snapshot.

## USD to sat settlement

The model provider receipt is USD. Settlement must additionally pin a fresh,
source-attributed USD/sat rational quote and bind its URL, bytes digest, observed
time, effective time, and freshness to the same operation. Conversion rounds up
to sats. `src/currency/btc-usd.ts` is display-only (and permits last-known
values), so it is expressly prohibited from authorization or debit.

No source snapshot, price-card provenance, bounded request envelope, or exact
provider receipt may be replaced by a development fixture, a free-tier
assumption, a synthetic sat rate, or an inferred project ceiling.

The current conservative certification inventory reserves a full model envelope
for all 1,000 accepted admissions on **each** worker provider, plus eight suite
operations per provider: 2,016 possible model calls. Admission cancellation has
not yet been proven to precede inference, so the quote cannot assume it avoids
model charges. Each call is bounded to 100,000 input tokens and 8,192 combined
output/thought tokens; both worker cohorts retain their 20-minute lifetime cap.
The controller's $2,000 policy ceiling is only a rejection threshold, not a
quote or approval. The exact fresh source-priced request must still be reviewed
and authorized before effects; no amount has been authorized or spent here.
