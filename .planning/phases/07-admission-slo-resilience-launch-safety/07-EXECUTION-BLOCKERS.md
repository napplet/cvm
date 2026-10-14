# Phase 7 execution readiness — 2026-10-14

**Scope correction:** The user subsequently deferred production readiness. These findings block production release only, not local development. See [the deferred-production runbook](../../../docs/runbooks/production-readiness-deferred.md) for the active decision and resumption conditions.

Status: implementation gaps prevent the existing operator checkpoint from becoming reviewable. Phase remains incomplete; no live certification or promotion occurred.

## Reproduced result

`bun run release:certify -- --candidate toolchains/candidates/initial.json --request` exits 1 with `local_setup_required` and all reported effect counters zero. The separately completed local Cashu/NWC stack supplies simulated development funds only and is not production certification evidence.

## Source findings

| Boundary | Evidence | Required correction |
| --- | --- | --- |
| Production composition | `src/release/deployment/production-dependencies.ts` exports `createProductionOperationalDependencies`, but no application call site constructs it. `production-factory.ts` rejects absent dependencies with `AUTHORIZED_EXECUTION_PORTS_REQUIRED`. | Build the concrete sixteen-provider/eight-suite dependency graph and compose it at the controller-owned factory boundary. |
| Preapproval | `src/release/preapproval-materializer.ts` exports `materializePreapproval`, but no application call site invokes it. | Materialize measured source/config/factory inputs through the CLI without asking the operator to author them. |
| Google transport | `google-clients.ts` requires a loopback HTTP origin and uses injected token/fetch ports. | Supply an actual authenticated production transport with verified vendor request/response contracts; removing the loopback check alone is insufficient. |
| Worker transport | `worker-clients.ts` requires a loopback Fly origin and an injected Modal SDK. | Supply scoped real transports and measured worker execution, retaining resource and isolation guarantees. |
| ContextVM and payments | `contextvm-client.ts` returns canonical identity/reference descriptors; `payment-clients.ts` returns reference discovery and operation-ID comparison. | Wire real transport and settlement observations to the funded core; descriptor presence is not a live observation. |
| Protected suites | `protected-ports.ts` wraps supplied adapters; it does not construct them. | Connect real suite observations, measured cost, ownership tracking, verification/finalization inputs, and resumable cleanup. |

Graph discovery returned no matching nodes for the newer production modules; scoped source inspection was used as the fallback. The findings above concern the deployment entrypoint; existing lower-level core and adapter implementations should be reused rather than rewritten.

Validation: `NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny bun test tests/release/production-factory.test.ts tests/release/production-dependencies.test.ts tests/release/production-readiness.test.ts tests/release/certify-release.test.ts --timeout 10000` passed 18 tests with 90 assertions. Passing refusal tests confirm the gates work; they do not prove live execution readiness.

## Execution order

1. Reopen implementation through gap-closure planning. Preserve completed plan summaries as historical records; do not label their fixture results as live readiness.
2. Inventory and connect the existing real adapters in a vertical controller path; implement missing transports against official contracts. Validate with contract tests and no-effect preapproval tests.
3. Demonstrate that the CLI constructs a reviewable source-bound request with complete dependencies before asking for funded wallet input or exact effect approval.
4. Complete the existing 07-20 local operator checkpoint, then run 07-26 under its bounded receipt. Require all real protected observations before phase completion.

The current 07-26 plan explicitly permits no implementation edits within its run-only tasks. These corrections require separate implementation plans/atomic fixes. There is no valid request to approve yet, and no reason to ask the operator to reconnect a wallet during this audit.
