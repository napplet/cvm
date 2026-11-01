# Quick 261101-pnd summary

The normal entrypoint (`scripts/production.ts`) boots one service composition
(`src/service/server.ts`) from `/etc/napplet-cvm/service.json` and mounted
secret files. It reuses the existing funding, metering, continuation, worker,
verifier, preview and publication classes. Migrations are a separate command
(`scripts/migrate.ts`) over the canonical sequence plus an immutable realm marker.
No Google dependency, certification or migration machinery runs at startup.

Deployment: `infra/service/compose.yaml` (PostgreSQL, relay, private build
engine with gVisor, service, optional test rails/Caddy) installed by the homelab
playbook `ops/cvm/ansible/deploy.yml` (`./homelab cvm production …`).

Live evidence on beta (test realm, private names via alpha Traefik), 2026-11-01:
- Worker boundary probe under runsc: uid 65532, CapEff 0, no_new_privs, read-only
  root, only loopback; DNS/public/private/metadata egress denied; full
  conformance build passed.
- Signed ContextVM flow (`scripts/service-flow.ts`): insufficient-funds pause,
  payable Lightning request credited, Cashu credit and replay without a second
  credit, explicit resume, gVisor build + conformance, exact ledger
  reconciliation, sandboxed preview origin, revision + identical replay without
  a second charge, foreign identity denied, user-signed publication copied to
  two user Blossom servers and announced. Worker start ~17 ms after the model step.
- Full stack stop/start: project reopened, same balance, no model call.
- Upgrade with automatic pre-upgrade backup; rollback to the previous revision.
- Backup snapshot captured through the homelab backup runner's remote volume
  path with all checksums intact; isolated restore verified identity, 56 tables /
  672 rows, 12 artifacts, ledger invariant, and project reopen (70 s restore).

Not complete:
- Paid OpenAI generation: the configured key's organization has no API credits
  (HTTP 429 insufficient_quota). The refusal now settles at zero charge.
  Live flow currently uses the test-realm deterministic model adapter.
- Real-money realm: needs a receive-only NWC connection, two real Cashu mints and
  public DNS/ingress. Not deployed; not production-ready.
- Homelab backup runner on alpha must be updated after the homelab branch merges
  (`./homelab backup install-runner`) to include the CVM volume nightly.
