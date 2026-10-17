# Deferred production readiness

**Decision, 2026-10-14:** prioritize a working local development environment. Production provisioning, operator funding/approval, and protected release certification are deferred at the user's direction. These items must not block local development or development e2e tests.

This deferral does not mark Phase 7 complete or establish production readiness. SESS-02 and OPS-01–OPS-04 retain their outstanding live-verification requirements. Plans 07-20 and 07-26 remain unexecuted.

## Development path now

- Start local Cashu, NWC and relay services: `bun scripts/dev-payments.ts`.
- Run isolated payment e2e with automatic setup/cleanup: `bun scripts/dev-payments.ts test`.
- Run the existing repository tests: `bun test --timeout 10000`.
- Continue application integration using local test services. Do not request production wallet material, cloud credentials, or release authorization for development work.

The development tests cover payment infrastructure plus the application funding coordinators and PostgreSQL ledger, including both Cashu mints, NWC credits, exact-command/token replay and pending-invoice recovery after restart. The composed [development workspace tests](development-gui.md) additionally cover ContextVM/CEP-8 and generation/preview boundaries; these do not certify production. See [development payments](development-payments.md).

## Work to revisit before production

| Work | Current gap | Completion evidence |
| --- | --- | --- |
| Execution composition | No application call site constructs `createProductionOperationalDependencies`; the factory requires the concrete sixteen-provider/eight-suite graph. | Controller constructs the complete graph and invokes real adapters under the exact receipt. |
| Preapproval materialization | `materializePreapproval` has no application call site. | CLI generates and measures source/config/factory inputs and produces a reviewable bounded request without operator-authored config. |
| Google and worker transports | Deployment clients include loopback-only/injected transports. | Authenticated vendor transports with verified API contracts, durable operation reconciliation and run-owned cleanup. Removing loopback restrictions alone is insufficient. |
| ContextVM and funding | Deployment descriptors do not perform actual protocol/settlement operations. | Real transport and settlement observations feed the funded core, with duplicate-credit and replay checks. |
| Treasury custody and ambiguous payments | Development ledger credits do not prove persistence of newly received Cashu proofs, ownership of a spent proof after an ambiguous swap, or recovery of an NWC create response lost before its payment hash is saved. | Durable treasury proof custody/recovery, evidence tying uncertain swaps to service-owned outputs, and query-only invoice reconciliation without duplicate credit or blind reissue. Include re-encoded spent-token attempts in release tests. |
| Protected observations | The suite factory requires concrete observation adapters; fixture success cannot stand in for them. | All eight fresh candidate-bound protected suites pass, including admission SLO, failure/recovery, telemetry, host/security, payment/model, publication and supply-chain checks. |
| Operator checkpoint | No executable production request is ready for review; saved Cashu readiness expired. | After implementation is ready, refresh service-owned funding and obtain exact bounded approval through 07-20's local surface. Owner signing remains deferred to publication. |
| Release finalization | 07-26 has not run. | Sole evaluator accepts real evidence, immutable release bundle is verified, and authorized resource cleanup is confirmed. |

Detailed source findings and the last no-effect readiness check are retained in [07-EXECUTION-BLOCKERS.md](https://github.com/napplet/cvm/blob/main/.planning/phases/07-admission-slo-resilience-launch-safety/07-EXECUTION-BLOCKERS.md). Its blockers apply to production release only.

## Resumption

Revisit when the user explicitly asks for production deployment or release readiness. Start with `$gsd-plan-phase 7 --gaps`, incorporating the source findings above. Execute the resulting implementation plans before offering operator funding or approval. Then complete 07-20 and run 07-26 against the exact authorized candidate.

Keep production verification deferred during development-only autonomous runs. Do not archive the milestone as complete, weaken release gates, or convert simulated payment observations into production evidence. Development success and production launch readiness remain separately reported.
