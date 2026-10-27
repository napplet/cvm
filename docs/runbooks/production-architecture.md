# Production architecture decision record

**Status:** preparation only, not a production-release claim.
**Decision date:** 2026-10-27.
**Preserved source service:** Coolify application `napplet-cvm`
(`x13wc0i56wce31hkg4jrtmsq`) on Beta.

## Decision

Keep the working private Beta deployment in place while the production
composition is prepared. It remains authoritative for its private development
identities, projects, artifacts, encrypted local state, test-ledger history and
audit history until a backup is restored into a fresh instance and a candidate
passes certification. It must not receive real-money traffic or be represented
as the production topology.

| Authority | Required production form | Demonstrated requirement | Status |
| --- | --- | --- | --- |
| ContextVM coordinator | Cloud Run in `europe-west1` and `us-central1`, three warm instances each | immediate admission/rejection and regional ingress measurement | Not provisioned |
| Ledger/session authority | one Cloud SQL PostgreSQL 17 **regional HA** instance, serializable transactions | authoritative balances, sessions, leases, idempotency and outbox | Not provisioned |
| Checkpoints/artifacts/evidence | encrypted, versioned dual-region GCS (`nam4`), 30-day lifecycle | instance-loss restore and retention evidence | Not provisioned |
| Build workspace | Modal Sandbox, immutable image, default-deny network, no inbound ports, hard resource/lifetime limits | production isolation boundary | Not provisioned or certified |
| Fallback measurement | Fly Machine with identical image/cohorts/restrictions | measured worker exit candidate, not an authority | Not provisioned or selected |
| Model | receipt-producing provider with current source-attributed USD pricing | exact usage settlement | Not selected |
| CEP-8 funding | real NWC Lightning and trusted Cashu custody/reconciliation | funded balance and immutable receipts | Not connected |
| Publication | NIP-46 user signer and promoted CLI/upload/relay path | user-owned signing and sealed publication | Not certified |

ContextVM over Nostr remains the only public generation interface. HTTP is
limited to approved artifacts, previews, and private authenticated operational
surfaces; it does not gain a public generation route.

## Preservation and accounting realms

Coolify, its lifecycle commands, the signed ContextVM identity, source mirror,
host state, existing artifacts, and audit history remain in the private
development realm. Existing ChatGPT credentials remain there only; no credential
is copied into a worker, production configuration, Git, or an approval request.

Compatible migrations may preserve owner, session, project, artifact, receipt
and audit history, including schema files under `migrations/development`. That
does not transfer financial authority. The `development-test` realm retains
test balances and receipts read-only. A separate `production-real` schema/role
begins at zero. Cross-realm balances, reservations, credits, debits, provider
receipts and operation identities are invalid by construction.

Production construction rejects FakeWallet, faucets, local mints, fixture
models, synthetic rate cards, development keys and development rail adapters.
Development-test balances cannot authorize or settle a production-real action.

## Failure domains and security claims

The Beta stack is one host with host-local state and a privileged nested Docker
engine. Its worker controls are useful private development containment; they do
not establish a multi-tenant production sandbox. Its local PostgreSQL and
volumes are neither regional HA nor dual-region object durability. Its private
ingress is not a public availability claim.

Cloud SQL regional HA protects a selected region across zones; it does not prove
cross-region database continuity. Two Cloud Run regions do not prove that a
database, object, worker or publication effect fails over cross-region. The
release claim must name the exact tested failure domain, RTO and RPO. Wider
continuity stays blocked until matching live drills pass. The existing two-region
Cloud SQL quantity contract is wrong for the single regional HA authority and
must be corrected and rebound before an authorization request.

No worker is selected until fresh identical Modal and Fly cohorts meet the
locked admission gate: 1,000 accepted samples, two 200-attempt forced cohorts,
p95 at most five seconds with one-sided 95% confidence, and zero accepted
backlog. Vendor startup claims and the private engine are not evidence.

| Boundary | Allowed | Prohibited |
| --- | --- | --- |
| Coordinator | scoped service credentials and original operation IDs | worker database/provider credentials and user keys |
| Worker | session inputs and brokered capabilities | inbound ports, unrestricted egress, control-plane secrets, durable cloud authority |
| Nostr | separate ContextVM/attestation keys and external user signer | the user's private key in CVM or worker |
| Cashu/NWC | encrypted custody with secret-broker key reference | plaintext proofs, preimages or connection strings in SQL, logs, evidence or Git |
| Release executor | candidate-bound factory after exact validated receipt | hand-authored provider clients, config, evidence or receipt input |

## Change control and remaining evidence

Plans must complete no-effect application wiring, source-bound pricing,
accounting separation, treasury recovery, protected-suite adapters and root
operator commands before the controller emits its one bounded request. Only an
unexpired matching receipt may unlock protected effects; a changed candidate,
topology, scope, price, cost or controller state invalidates it.

The CVM repository uses a feature branch and `origin/main`; homelab uses its own
feature branch and `origin/master`. Each gets a scoped commit, push, PR and
merge. There is no atomic cross-repository commit, and live state never gets
ahead of merged mainline configuration.

This record is not certification. Admission, telemetry, chaos, restore,
security-host, supply-chain, ContextVM-payment-model and publication suites
must all produce fresh candidate-bound real records before promotion or public
traffic.
