---
phase: 07
plan: "65"
status: in_progress
scope: non-google-model-costs
---

# Plan 65 non-Google model-cost handoff

## Controlling boundary

D-141 excludes new Google Cloud, Vertex/Gemini, ADC, BigQuery, Cloud Run,
Cloud SQL, and GCS production work. Historic Vertex pricing, receipt, and
report records remain readable for audit/recovery and are not rewritten. This
slice has no provider credential, model, funding, signing, deployment, login,
or account-creation effect.

## Current compatibility map

| Surface | Current writer | Current reader | Transition treatment |
| --- | --- | --- | --- |
| Official prices | `official-sources.ts` fetches Google catalog/ADC and public vendor pages | `production-catalog.ts` and certification code | Preserve v1 readers; add a closed v2 non-Google role/cost schema. |
| Production catalog | `production-catalog.ts` makes fixed Google/Vertex facts and project ceilings available | authorization/report callers | Preserve its historical fixed catalog/hash; ensure the v2 cost bound never turns ceilings into vendor prices. |
| Model operation | `vertex-client.ts` persists before Vertex POST and reconciles an original interaction | Vertex journal/recovery tests | Preserve decoder/history; add an OpenAI Responses candidate with an explicit injected journal/HTTP seam. |
| Usage report | `authoritative-usage-report.ts` renders a versioned v1 artifact | audit/report tests | Add a versioned v2 expansion only; v1 bytes stay stable. |

## Targeted RED/GREEN proof plan

1. RED: prove the non-Google catalog rejects project ceilings, stale/missing
   price facts, unsupported currencies, and unknown scope/contract mapping;
   prove exact bigint/rational bounds are zero-effect.
2. GREEN: introduce closed roles and source-attributed native usage facts.
3. RED: exercise a Responses request through an injected HTTP transport and
   injected durable journal, including timeout/recovery/no-resend and malformed
   receipt handling.
4. GREEN: persist original operation/nonce/request/rate/max-charge before POST,
   parse provider usage strictly, hash the raw response, and compute a capped
   exact cost without reading environment credentials.

## Deliberate non-goals / material unknowns

- No v2 runtime/factory, provider registry, config, secrets, PostgreSQL journal,
  or normal request wiring: Plans 67/70 own the full graph.
- API account scope, project/billing arrangement, contract discounts and model
  availability are not inferred from a model GET; they remain held until a
  documented authenticated verification flow is approved.
- This candidate does not certify a provider, deploy, spend, or make normal
  production work ready.

## Official sources captured for implementation

- OpenAI Responses create/reference and token-counting docs establish
  `POST /v1/responses`, `max_output_tokens`, response IDs, and usage categories.
- OpenAI pricing documents native USD per-million-token rates. Price snapshots
  bind a specific source URL/digest/time and must not represent a contract rate.
