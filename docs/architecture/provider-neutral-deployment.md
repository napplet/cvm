# Deployment

Run the CVM as a containerized service on any compatible Linux host or VPS. This repository owns the application, images, Compose definition and configuration contract. Keep Ansible playbooks, inventories, host routing and deployment records in a separate operator-owned repository. Google Cloud is excluded.

The application has one architecture. Configure concrete adapters at startup:

| Concern | Existing boundary |
| --- | --- |
| Transactional accounts and sessions | `PostgresSqlPool` / `PostgresSqlFundingStore` |
| Checkpoints and artifacts | `ObjectStorePort` / `VersionedObjectClientPort` |
| Metered model calls | `ModelGateway` |
| Isolated execution | Existing worker ports and adapters |
| Metrics and traces | `LifecycleTelemetryPort` and OTLP |
| Deployment | Portable container configuration; operator-owned deployment automation |

Keep provider credentials in adapter/bootstrap code and secret mounts, outside the domain core and generated applets. Choosing a provider changes configuration and its adapter, not funding, sessions, publication, or authorization protocols.

Start with the existing service and ordinary PostgreSQL, storage, backups, and private administration. Do not add a cluster, a custom object database, a second provider graph, or a certification orchestration system to replace Google Cloud.

Preserve data and service identity during deployment. Test balances remain test balances; production money still requires exact metering, funded caps and safe recovery. Generated code still requires enforced isolation. Checkpoint encryption/retention and user-owned signing remain product behavior.

## Selected adapters

`src/service/server.ts` is the one composition root; `scripts/production.ts` boots it from `/etc/napplet-cvm/service.json` and secret files under `/run/secrets/napplet-cvm`. It reuses the funded admission, metered generation, continuation, preview and publication services used by the local development flow.

| Concern | Selected implementation |
| --- | --- |
| Accounts, ledger, sessions | PostgreSQL 17 (`PostgresFundingDatabase`), canonical migrations in `src/service/migrations.ts`, applied by `scripts/migrate.ts` (never at startup) |
| Realm separation | Immutable `service_realm` marker per database; `real` refuses test rails, private mint routes, plaintext relays, `runc`, and any database with prior ledger history |
| Funding | NIP-47 receive-only invoices (payable BOLT11 returned to the requester) and Cashu swaps at two or more allowlisted mints |
| Model | OpenAI Responses with exact usage receipts, lookup reconciliation and captured, digested price sources (`scripts/model-pricing.ts`); explicit refusals settle at zero, uncertain outcomes reconcile before retry |
| Isolated execution | Private Docker engine; workers under gVisor `runsc`, no network, read-only root, no capabilities, uid 65532, limits |
| Artifacts and checkpoints | Filesystem volume: content-addressed, digest-verified sealed artifacts; AES-GCM pending-action envelopes keyed from the mounted service seed, 30-day expiry |
| Preview | Pinned Paja runtime on a separate preview origin with `sandbox` CSP |
| Publication | User-signed manifests copied by the user's client to user-owned Blossom servers through the `@napplet/cli` upload authorization; the service signs only its own preview copies |
| Deployment | `infra/service/compose.yaml` with operator-supplied configuration; see [service deployment](../runbooks/service-deployment.md) |

Google Cloud, Cloud Run, Cloud SQL, GCS, Vertex and the hosted worker providers are not used. The legacy `src/production/*` bootstrap remains in the tree as historical code and is not on the startup path.
