# Container deployment

This repository provides application images, `infra/service/compose.yaml`,
a configuration schema and backup/restore tools. Keep Ansible playbooks,
inventories, DNS records, host access, secret provisioning and scheduled backup
collection in a separate deployment repository owned by the operator.
No private infrastructure repository or provider-specific operator CLI is required.

## Requirements and configuration

The supplied stack targets Linux AMD64 with Docker Engine and Compose. It runs
PostgreSQL 17, a Nostr relay, a dedicated gVisor build engine and the CVM service.
The engine needs privileged container support; the application never receives
the host Docker socket. Untrusted workers use `runsc`, no network, read-only
roots, dropped capabilities and resource limits. This is one host with no
replication or automatic failover.

Choose a service root (the examples use `/srv/napplet-cvm`) with this layout:

```text
/srv/napplet-cvm/
  current -> releases/<revision>     # clean source checkout
  releases/<revision>/
  compose.env
  config/service.json
  config/model-pricing.json
  secrets/postgres_password
  secrets/database_url
  secrets/service_seed
  secrets/openai_api_key
  secrets/nwc_uri
  data/postgres/
  data/storage/
  data/relay/
```

Use a reviewed Git revision. `compose.env` supplies the paths and network values:

```dotenv
NAPPLET_CVM_ROOT=/srv/napplet-cvm
NAPPLET_CVM_PROJECT=napplet-cvm
NAPPLET_CVM_REVISION=REPLACE_WITH_GIT_REVISION
NAPPLET_CVM_BIND=127.0.0.1:18871
NAPPLET_CVM_DNS=REPLACE_WITH_REACHABLE_DNS_SERVER_IP
```

Start from `infra/service/service.example.json`,
validated by `src/service/config.ts`. Replace all example origins, mint URLs,
policy identifiers and image selections with values appropriate to your
installation. The three HTTPS origins serve the workspace, isolated preview
and Blossom artifacts. Route their traffic to the service listener; route
`/relay` WebSocket traffic to the relay container. Keep administrative access
private. The optional `caddy` profile reads an operator-supplied
`config/Caddyfile`; an existing reverse proxy can provide TLS instead.

Secrets are UTF-8 files under `secrets/`, never configuration values or source
files. Use mode 0600 and directories readable only by the operator and required
containers. `database_url` must match the PostgreSQL credentials and database;
`service_seed` is a persistent 32-byte hexadecimal seed defining service identity
and encryption keys. `nwc_uri` must authorize only `make_invoice` and
`lookup_invoice`. Preserve these files through upgrades and restores.
Create data directories with ownership suitable for each pinned container
(PostgreSQL, relay and application), rather than opening them to all users.

`realm: test` balances are test credits. `realm: real` requires a metered model,
TLS public relay, two independent real Cashu mints, a sandboxed worker runtime
and a fresh database. Its immutable `service_realm` marker prevents promoting
a test ledger or prior accounting history into real money. The `test-rails`
Compose profile is for test deployments only and requires additional test-wallet
and mint secrets; inspect its mounts before enabling it.

## Build, migrate and start

Run these commands on the deployment host from the selected checkout. The
operator supplies files and ownership described above first:

```sh
cd /srv/napplet-cvm/current
export NAPPLET_CVM_ROOT=/srv/napplet-cvm
compose() {
  docker compose --env-file "$NAPPLET_CVM_ROOT/compose.env" \
    -f infra/service/compose.yaml "$@"
}
compose build cvm engine
docker build -t napplet-cvm/dev-worker:development infra/dev-ui
docker build -t napplet-cvm/dev-publication:development infra/dev-publication
compose up -d --wait postgres relay engine
docker save napplet-cvm/dev-worker:development napplet-cvm/dev-publication:development \
  | compose exec -T engine docker --host unix:///run/cvm-docker/docker.sock load
compose run --rm --no-deps --entrypoint bun cvm scripts/migrate.ts
compose run --rm --no-deps --entrypoint bun cvm scripts/migrate.ts --check
compose up -d cvm
compose ps
```

Generate the non-secret pricing document with `bun scripts/model-pricing.ts`
and mount its output at `config/model-pricing.json` before starting the service.
This command fetches provider prices and an exchange-rate quote. Inspect the
script's options and retain captured price sources. Pricing expires after
72 hours. Refresh requires restart, and recovery across changed price/profile
identifiers is an outstanding launch limitation; do not assume a routine
refresh preserves resumability until that behavior is fixed and verified.

The normal entrypoint is `scripts/production.ts`. It reads
`/etc/napplet-cvm/service.json` and `/run/secrets/napplet-cvm/*`; it never runs
migrations implicitly. Readiness is reported at `/health`. Configure persistent
storage, routing, secret creation, service supervision and deployment records
in your deployment repository.

## Verify a deployment

The portable flow driver uses signed ContextVM requests and a client-owned key:

```sh
bun scripts/service-flow.ts --origin https://cvm.example.org \
  --identity ./flow/user.key --state ./flow/state.json --phase full \
  --cashu-token-file ./flow/top-up.token
bun scripts/service-flow.ts --origin https://cvm.example.org \
  --identity ./flow/user.key --state ./flow/state.json --phase reopen
```

The full flow can spend model credits and funds: review its configured maximum,
provide a bounded Cashu token and pay the returned Lightning request when
required. Test rails settle only test balances. Reopening checks the existing
artifact and balance without generating another model response. Preserve the
client key and state locally; never give the service a user's signing key.

## Backup, restore and rollback

`infra/service/backup.sh <root> [volume]` creates a transactional PostgreSQL dump,
storage archive, configuration/secrets archive, manifest and checksums in a
Docker backup volume. It expects `current`, `compose.env` and `deployed.json`
(an operator-created deployment record) under the chosen root. Execute it with
permissions to access Docker volume data. The default volume is
`napplet_cvm_backup` and the default retention is three snapshots.

The snapshot includes secrets. Configure encrypted off-host collection and a
schedule in your deployment repository, verify collection and test restoration.
The application repository does not install a timer or configure a backup host.
Quiesce writers during verification if comparing row counts captured separately
from the database dump. Single-host loss requires recovery from the last
successfully collected snapshot; recovery time and data loss depend on your
measured restore procedure and backup interval.

`infra/service/restore-test.sh <backup-dir> [restore-root] [flow-dir]` verifies
checksums and restores an isolated stack with separate data, network and port.
It requires the recorded source release and worker images on the host; see the
script's `NAPPLET_CVM_LIVE_ROOT`, restore-root, project and port options. It
verifies identity, schema, artifact integrity, ledger projection and optionally
reopens a saved project. Test this on a compatible host before relying on it.

For actual recovery, stop application writers, preserve the damaged data for
inspection, restore the dump into a fresh database and restore storage,
configuration and secrets from the same snapshot. Start the recorded revision
and verify identity, accounting, artifacts and client reopen.

Take a backup before upgrading. Migrations are append-only: an older revision
refuses a database with unknown newer migrations. Rollback across schema changes
requires restoring the corresponding pre-upgrade snapshot before starting the
older revision. A rollback must not reissue payments or model operations.
