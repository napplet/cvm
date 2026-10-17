# Admin jobs and accountable usage

## Goal
Make operator jobs useful by default and preserve billable usage through source-processing failures. Missing provider evidence must remain visibly unresolved, with reserved funds intact, rather than becoming a free or duplicate model request.

## Work
1. Add an All view, explicit Needs review category, readable job summaries, cost/reservation information, search, counts, pagination, and structured job details. Keep provider configuration private and accessible.
2. Persist correlated usage receipts before source parsing/persistence; recover known usage without redispatching a model. Use historical pinned rates for any settlement and retain unresolved reservations when evidence is absent.
3. Verify gateway failures, accounting recovery, operator authorization, and responsive admin behavior. Update operator documentation with screenshots.
4. Refresh the idle local service, record verification, commit, and push main.

## Acceptance
- All is the default; unresolved billing is distinguishable from active generation.
- Operators can identify, filter, and inspect jobs without reading raw JSON or full opaque identifiers.
- Known provider usage survives malformed generated output or source-storage failure.
- Receipt checks never generate again, fabricate usage, or release unresolved funds.
- Costs clearly distinguish confirmed charges from held authorization and local test sats.
