# Production provider billing: non-Google transition

## Status

This is a no-effect candidate contract, not a production selection or an
authorization request. D-141 excludes Google Cloud, Vertex/Gemini, ADC,
BigQuery, Cloud Run, Cloud SQL, and GCS from new production work. Historic
receipts, catalogs, and report artifacts stay readable for audit/recovery.

The candidate uses the direct OpenAI Responses API with an API-billed secret
reference only. It never treats a ChatGPT subscription or OAuth credential as
an API key, and it has no `.env`, profile, ambient credential, or account
fallback. The fixed API origin is `https://api.openai.com`; the pinned model
identifier must include a dated version suffix. A provider constructor receives
an explicit authorization callback and an explicit durable journal.

## Source and rate contract

The public pricing source is [OpenAI API pricing](https://developers.openai.com/api/docs/pricing).
The capture records raw bytes, SHA-256, source URL, observed/fresh-until times,
USD currency, model, and input/cached-input/output rates. The source does not
establish account scope, project billing arrangement, negotiated discounts,
availability, or entitlement; those facts remain `unknown_held` pending the
later documented authenticated approval flow.

The [Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
and [token-counting guide](https://developers.openai.com/api/docs/guides/token-counting)
establish `POST /v1/responses`, `max_output_tokens`, response IDs, and that
reported output includes reasoning/non-visible tokens. Input, cached input,
cache write, and output are partitioned once; reasoning is recorded as an
output subset and is never charged a second time. A cache write without a
source-bound rate is held rather than estimated.

Project policy ceilings are an independent maximum bound. They are never
copied into vendor rate fields or represented as source-attributed prices.

## Original-operation and recovery contract

Before credential access or POST, the candidate commits the original operation
ID, nonce, canonical request digest, pinned model, price quote digest, maximum
charge, and client request ID through a serializable PostgreSQL operation
journal adapter. The response body is captured as native authenticated HTTP
bytes, hashed, strictly parsed, and recomputed from the request-bound price.
It is service-owned receipt/attestation evidence, not a provider signature and
not caller-supplied JSON.

On a known response ID, recovery only performs `GET /v1/responses/{id}`. If
the initial request lacks a known response ID, it remains `unknown` with the
client request ID preserved for support: no resend, list search, zero-cost
result, or new operation is permitted. Errors remain code-only; API keys, raw
stderr, and raw provider payloads are not emitted in runbooks or logs.

## Readiness boundary

This code does not construct the normal request-v3 provider graph, select the
candidate, provision a secret, query account/project state, issue a billing
report, or settle a funded user action. Plans 67/70 own integration after all
required authenticated and measured facts are available. The existing
CVM/homelab activation guards remain delivered and must not be bypassed.
