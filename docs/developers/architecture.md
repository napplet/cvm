# Architecture

The **generation core** is transport-neutral. The current public adapter maps verified ContextVM requests into domain commands. The development composition supplies concrete local services without making the browser a privileged control plane.

```text
Static browser / MCP host
        │ signed + encrypted ContextVM
        ▼
Nostr relay → SDK bridge → strict tool adapter
                              │ verified principal + domain command
                              ▼
                    Admission / session coordinator
                      │         │           │
                SQL ledger   Model gateway  Continuity
                                │              │
                         durable proposal   checkpoints
                                ▼
                        isolated build worker
                                ▼
                     sealed, verified artifacts
                          │             │
                      preview       publication
```

## Boundaries and ownership

| Layer | Owns | Must not own |
| --- | --- | --- |
| Static UI | Drafts, signer interaction, public discovery, progress, client-side blob propagation | Provider credentials, arbitrary account authority |
| SDK bridge | Verified event context, encrypted transport, reply correlation | Financial replay decisions |
| Tool adapter | Strict argument validation and verified principal injection | SDK objects inside domain services |
| Coordinator | Admission, versioned actions, operation identity, dispatch ordering | Executing arbitrary generated code on its host |
| Ledger/store | Durable account/cap/action reservations, receipts and replay records | Trust in an in-memory relay cache |
| Model gateway | Bounded dispatch and lookup, normalized receipts/proposals | Publishing or signing as a user |
| Worker/verifier | Isolated scaffold/build/checks and artifact evidence | Provider, database, user or cloud secrets |
| Publication | Prepared exact manifest, user signature checks, confirmed destinations | A substitute user signing key |

## Important code paths

[ContextVM adapter](https://github.com/napplet/cvm/blob/main/src/contextvm/adapter.ts) validates the public tool union. [SDK bridge](https://github.com/napplet/cvm/blob/main/src/contextvm/sdk-bridge.ts) verifies the request event and correlation before dispatch. [Development composition](https://github.com/napplet/cvm/blob/main/src/dev-ui/contextvm-server.ts) connects the local implementation.

[Metered generation](https://github.com/napplet/cvm/blob/main/src/phase-04/metered-generation-service.ts) coordinates paid actions. [ModelGateway](https://github.com/napplet/cvm/blob/main/src/model/model-gateway.ts) separates `dispatch` from lookup-only recovery. [Session status](https://github.com/napplet/cvm/blob/main/src/phase-04/session-status.ts) projects durable progress, billing and next actions.

## Durable truth and live activity

PostgreSQL owns balances, holds, sessions and idempotency records. Immutable source/artifact/checkpoint data lives alongside protected evidence in the configured storage implementation. Both must agree before completion is reported.

A request follows these broad boundaries:

1. Verify the principal and command; establish bounded approval and admission.
2. Record the exact model operation and reservation before provider dispatch.
3. Record source and usage evidence durably; recover from this record if later work fails.
4. Build and validate in isolation; seal the accepted artifact.
5. Settle the exact recorded charge and expose a verified version.

Progress notifications describe activity; they do not replace these durable transitions. A browser disconnect does not revoke a dispatched operation. A provider timeout cannot safely be translated into “nothing happened.”

## Development versus production

Development runs real local relay/payment/SQL/worker boundaries with fake Lightning settlement and optional fixture inference. The planned managed topology and historical promotion contracts have separate certification requirements. Read [deferred production work](../runbooks/production-readiness-deferred) before treating Cloud Run, Modal or HA diagrams as a working deployment recipe.
