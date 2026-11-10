---
id: 261110-dtq
status: complete
date: 2026-11-10
---

# Operator-owned payments and generic credits

The public CVM owns integer credits, exact API metering, funded admission,
holds, signed caps and durable sessions. External modules own payment methods,
verification, sale prices and conversion. Multiple modules are selected at
bootstrap; advertised methods drive browser selection. Payment-free operation
uses an explicit npub allowlist and bounded sponsored credits. Subscriptions can
grant scoped, idempotent credits through an adapter without core subscription logic.

The existing Lightning/NWC and Cashu implementation, dependency, operational
rails and dependent test suites were extracted into a new private repository.
Typed legacy forwarding entrypoints preserve installed callers. Existing settlement
identities, account balances, holds, keys and history remain intact. The additive
migration broadens source identifiers without rewriting historical entries.
Modern requests specify credits; legacy requests specify source amount; ambiguous
requests containing both are rejected.

Human and agent integration guidance is in
`docs/architecture/payment-adapters.md`. Pricing uses explicit operator credit
policy and exact rational arithmetic. Adapter grants are namespaced, conflicting
replays rejected, cumulative overflow bounded, and signed free requests validated
before credits can be issued.

## Review and rollout

- Public PR: https://github.com/napplet/cvm/pull/115 (stacked on #114).
- Private adapter PR: recorded in the operator repository; repository visibility
  verified private. Implementation and lockfile are committed and pushed.
- Runtime application revision: `9f2a1fa1a0238e73ad292b3282a6d1b20dda9714`.
- Both existing operator deployments package exact application/adapter revisions;
  backups precede upgrade. Keys, volumes and databases were reused. Private
  infrastructure details and deployment records remain outside this repository.
- Original workspace: signed service discovery, real private-adapter Cashu funding,
  bounded real ChatGPT generation, verified interactive sandbox preview and reopen
  pass. An artifact created before upgrade also reopened unchanged.
- Separate service: healthy schema and containers; real signed test-rail Lightning,
  Cashu and replay checks pass. Its configured OpenAI credential returns HTTP 401,
  so its full generation/publication flow remains blocked; rejected generation
  records zero spend. The original workspace's real generation passes.

## Validation

Focused public adapter/free-access tests pass (11); private default regressions
pass (108, 3 skipped); actual PostgreSQL migration/concurrency/restart checks pass
(5). Both TypeScript projects pass. The final real isolated end-to-end suite has
167 passes, 1 skip and no failures, exercising Cashu/NWC, worker generation,
pause/resume, replay and restart. See VERIFICATION.md for broad-suite limitations.

Root-wide verification initially produced 961 passes, 13 skips and seven failures
under heavy concurrency. Failed relay/proof-gate files passed isolated reruns;
the expensive proof gates used a 60-second per-test runner timeout. Production
timeouts and protection rules were not relaxed. Historical OTel approvals retain
their original manifest binding and fail closed for the changed dependency root.

Downgrading to pre-extraction code requires explicitly restoring a compatible
database snapshot: the older application rejects newer migration history.
Operator rollback tooling refuses an implicit downgrade. Phase 7 and real-money
activation remain incomplete.
