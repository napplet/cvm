# Service deployment, backup, restore and rollback

The CVM is one containerized service. A host — a homelab machine or a VPS — runs
one Docker Compose stack, installed and upgraded by a small Ansible playbook in
the homelab repository (`ops/cvm/ansible`). Hosts differ only by inventory.

## What runs

| Container | Purpose | Persistent data |
| --- | --- | --- |
| `cvm` | `scripts/production.ts`: ContextVM service, static workspace, preview and Blossom origins | `data/storage` (sealed artifacts, worker results, published copies) |
| `postgres` | PostgreSQL 17, the canonical migration sequence | `data/postgres` |
| `relay` | Nostr relay the service listens on; exposed as `wss://<public>/relay` | `data/relay` (ephemeral events) |
| `engine` | Private Docker engine for untrusted builds. Workers run under gVisor (`runsc`), `--network none`, read-only root, all capabilities dropped, uid 65532, CPU/memory/PID limits | engine image cache (rebuildable) |
| `test-mint`, `test-wallet` | Test realm only: FakeWallet Cashu mint and receive-only NWC wallet | test rail state |
| `caddy` | VPS only: TLS for the three names | ACME state |

Configuration is mounted at `/etc/napplet-cvm/service.json` (one adapter per concern:
PostgreSQL, filesystem storage, OpenAI Responses, Docker worker runtime, NIP-47 +
Cashu rails). Secrets are files under `/run/secrets/napplet-cvm`: `database_url`,
`service_seed` (defines the service's Nostr identity and server-side keys),
`openai_api_key`, `nwc_uri`. Nothing Google-specific is required.

`realm: test` balances are test credits. `realm: real` holds real money and
refuses test rails, private mint routes, plaintext relays and `runc`. Each
database records its realm once (`service_realm`); a test database can never be
started as the real-money service, and a database with ledger history cannot be
initialized as real.

## Deploy or upgrade

```sh
cd ~/Develop/homelab
./homelab cvm production deploy --revision <40-hex commit pushed to a remote branch>
./homelab cvm production status
```

The playbook: archives exactly that commit (never the working tree), unpacks it
to `releases/<sha>`, takes a backup when the running revision changes, builds
the images, starts PostgreSQL/relay/engine, loads the worker images into the
engine, runs `scripts/migrate.ts` (canonical migrations + realm marker, never at
service startup), starts the service, checks `migrate.ts --check` and records
`deployed.json` (`revision`, `previous`, `servicePubkey`). Generated secrets are
created once and never rotated by a deploy.

Operator inputs live in `~/.config/napplet-cvm` (mode 0600): `openai_api_key`,
and for the real realm `nwc_uri` (a **receive-only** NWC connection:
`make_invoice`, `lookup_invoice`). The model pricing document is regenerated on
each deploy by `scripts/model-pricing.ts` from OpenAI's published price table and
a BTC-USD quote, with captured bytes and digests; it is valid for 72 hours, so
redeploy (or restart after regenerating) at least every three days.

For a VPS copy `inventory/vps.example.yml`, set the host, origins, mints and
`cvm_realm`, point DNS at the host, and run the playbook with that inventory.

## Verify the user flow

```sh
./homelab cvm production flow --flow-dir ~/.local/state/napplet-cvm-flow --phase full
./homelab cvm production flow --flow-dir ~/.local/state/napplet-cvm-flow --phase reopen
```

`scripts/service-flow.ts` acts as a user with its own key: signed, encrypted
ContextVM over the public relay; insufficient-funds pause; Lightning (payable
BOLT11 returned to the requester) and Cashu top-ups with replay; resume of the
saved action; metered generation with exact ledger reconciliation; sandboxed
preview from the preview origin; revision and identical replay without a
second charge; another identity denied; user-signed publication copied to two
user-controlled Blossom servers via the `@napplet/cli` upload authorization.
`reopen` reopens the same artifact with the same balance and no model call.

## Backup

`backup.sh` (systemd timer, daily 02:30, and before every revision change) writes
`database.dump` (one transactional `pg_dump`), then `storage.tar`, `state.tar`
(config, secrets, `deployed.json`), row counts, a manifest and `SHA256SUMS` into the
Docker volume `napplet_cvm_backup` (latest three kept). On homelab the existing
Borg backup collects that volume from beta (`ops/backup/sources.json`, service
`napplet-cvm`). The snapshot contains secrets; Borg encrypts it.

```sh
./homelab cvm production backup
```

## Restore test (required after changes to data or deployment)

```sh
./homelab cvm production restore-test --flow-dir ~/.local/state/napplet-cvm-flow
```

`restore-test.sh` restores the latest snapshot into an isolated, unrouted stack
(`/srv/napplet-cvm-restore-test`, separate project, network, relay and engine),
checks `migrate.ts --check`, starts the service, runs `scripts/verify-restore.ts`
(identity, realm, per-table row counts, every artifact file re-read with a
verified digest, ledger vs. balance projection) and reopens the user's project
through the restored service. It then removes the isolated stack.

To recover for real: stop the stack, move `data/` aside, extract the snapshot's
`state.tar` and `storage.tar` into the root, `pg_restore` `database.dump` into a
fresh `postgres`, and deploy the revision named in its manifest.

## Rollback

```sh
./homelab cvm production rollback      # redeploys deployed.json "previous"
```

Migrations are append-only. A revision refuses a database migrated by a newer
revision (`SERVICE_MIGRATION_UNKNOWN`), so rolling back across a schema change
means restoring the pre-upgrade snapshot that the deploy took, then deploying the
previous revision. Rollback never replays payments or reissues money.

## Availability, honestly

One host, one PostgreSQL, no replica, no automatic failover. A host or disk loss
means restoring the latest snapshot (at most one day old, plus pre-upgrade
snapshots) onto a host and redeploying; work since that snapshot is lost and
in-flight top-ups/generations reconcile from the provider on restart. Unknown
model and payment outcomes are reconciled before retry; they never charge twice.
Accepted work is not queued durably: if the service restarts mid-generation the
action is recovered or resumed explicitly by the user.

## Private Beta (unchanged)

The existing Coolify CVM (`./homelab cvm deploy`) remains the private
development/test-credit service with the ChatGPT workflow. It is separate from
this stack and keeps its own data.
