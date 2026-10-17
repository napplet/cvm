---
id: 261017-ccq
status: complete
completed: 2026-10-17
---

Added both cost and time estimations, as explicitly confirmed by the user. Executed inline through gsd-quick.

## Missing capability flag

Before this task, applet-generation estimates were absent from the public CVM interface. COST-01 was deferred to v2 in REQUIREMENTS.md; existing release/costs estimators cover infrastructure release authorization. This task implements new development CVM estimation functionality, not just a GUI connection to an existing estimate API. REQUIREMENTS.md now records that distinction. The promoted production core remains without equivalent estimates; production is deferred and does not block this development work.

## Delivered

- Signed `service_info` returns caller-only historical cost and duration ranges. The query matches the current runtime profile/card, uses recent successful actions, excludes reconciliations/invalid durations, caps sample size, keeps money exact and pads observed bounds. No extra model requests, provider credentials, project records or HTTP API.
- Setup and revision composer show estimates with sample provenance, limited/no-history states and a separate maximum. Live activity shows approximate remaining time, stale-update handling and overruns; completion shows the confirmed charge. Recovery never starts a new ETA and old saved work does not invent an actual duration/charge.
- Preflight refresh and identity-aware setup reads use CVM exclusively. Post-completion estimate refresh does not hold the completed action open. Static client remains independently hostable.
- Updated user guides, four screenshots, implementer reference and generated schema catalog.

## Verification

- 7 focused unit/security tests (32 assertions): ranges, exact large integer money, invalid/empty history, current pricing and verified identity scope, schema rejection.
- Controlled-clock product UI: estimates, separate maximum, stale updates, overrun, actual charge, recovery; existing keyboard/focus/revision controls pass.
- Real returning-projects journey: relay, SQL, Cashu, Docker, OAuth model fixture, Paja; owner history present after success, other identity has no history, active work excluded, estimates survive reload, no extra inference.
- Full product journey: 6 fixture model requests; generation, revision, pending request reload/recovery, intentional worker failure, interrupted response reconciliation and explicit next revision all pass.
- 323 responsive application checks across 19 viewports from 280px to 2560px, including short landscape.
- Docs build, 1,303 local links, generated catalog drift check, 90 browser layouts and 130 screenshot checks pass.
- TypeScript 5.9.3 still reports the same 424 existing diagnostics; no diagnostics in newly added files or changed browser/tests. Existing server diagnostics remain unchanged in kind.
- Live read-only GUI smoke test passes at http://127.0.0.1:49371. Idle checked before restart; saved chatgpt-oauth configuration and worker image preserved. No live subscription request or publication performed. Docs preview remains at http://127.0.0.1:4173/docs/.

## Limits

These are rough ranges from the caller's recent successful runs, not prompt-specific predictions or statistical confidence intervals. New identities/configurations may have no usable history. Costs in this development composition are test sats, not API dollars or ChatGPT allowance. Production estimation remains deferred.
