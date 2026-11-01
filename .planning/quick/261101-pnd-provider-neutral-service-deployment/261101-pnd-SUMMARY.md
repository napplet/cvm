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

Paid generation (after OpenAI credits were added), revision c5f06287c31e:
- Two real gpt-5-mini generations, each verified under gVisor (build +
  conformance), charged exactly 15 sats from the usage receipt; settled funds
  9999 -> 9969. Revision replay charged nothing. Publication announced.
- Explicit refusals (429 insufficient_quota) settled at 0; a verify-stage rejection
  of nonconforming generated code charged actual usage (18 and 16 sats) and sealed
  no artifact. Instructions now state the unused-variable compile rules.
- Latency (single runs, not p95): admission 53 ms; isolated worker start 19 ms
  after the model step, first in-container stage ~160 ms; model ~30 s.

Not complete:
- Real-money realm: needs a receive-only NWC connection, two real Cashu mints and
  public DNS/ingress. Not deployed; not production-ready.
- Homelab backup runner on alpha must be updated after the homelab branch merges
  (`./homelab backup install-runner`) to include the CVM volume nightly.
- p95 startup measurement under concurrent load was not run.
