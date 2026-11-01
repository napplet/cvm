#!/usr/bin/env bash
# Restore a napplet-cvm backup into an isolated, unrouted instance on this
# host and verify the restored application and data. The live stack is not
# touched: separate compose project, data root, network, relay, engine and port.
#   restore-test.sh <backup-dir> [restore-root] [flow-dir]
# flow-dir (optional) holds user.key and flow-state.json from a prior user
# flow; it is used to reopen the same project through the restored service.
set -euo pipefail
BACKUP="$(realpath -e "${1:?backup dir required}")"
RROOT="${2:-/srv/napplet-cvm-restore-test}"
FLOW_DIR="${3:-}"
PROJECT="${NAPPLET_CVM_RESTORE_PROJECT:-napplet-cvm-restore-test}"
BIND="${NAPPLET_CVM_RESTORE_BIND:-127.0.0.1:18879}"
LIVE_ROOT="${NAPPLET_CVM_LIVE_ROOT:-/srv/napplet-cvm}"
case "${RROOT}" in *restore*) ;; *) echo "restore root must contain 'restore'" >&2; exit 2 ;; esac
[[ "$(realpath -m "${RROOT}")" != "$(realpath -m "${LIVE_ROOT}")" ]] || { echo "refusing to restore over the live root" >&2; exit 2; }

started=$(date +%s)
(cd "${BACKUP}" && sha256sum --quiet -c SHA256SUMS)
REVISION="${NAPPLET_CVM_RESTORE_REVISION:-$(jq -r .revision "${BACKUP}/manifest.json")}"
[[ -d "${LIVE_ROOT}/releases/${REVISION}" ]] || { echo "release ${REVISION} is not present on this host" >&2; exit 3; }

compose() { docker compose -p "${PROJECT}" --env-file "${RROOT}/compose.env" -f "${RROOT}/current/infra/service/compose.yaml" "$@"; }
if [[ -f "${RROOT}/compose.env" ]]; then compose --profile test-rails down -v --remove-orphans >/dev/null 2>&1 || true; fi
rm -rf -- "${RROOT}"
install -d -m 0700 "${RROOT}" "${RROOT}/data" "${RROOT}/data/postgres"
install -d -m 0700 -o 1000 "${RROOT}/data/relay"
tar -C "${RROOT}" -xf "${BACKUP}/state.tar"
tar -C "${RROOT}/data" -xf "${BACKUP}/storage.tar"
ln -s "${LIVE_ROOT}/releases/${REVISION}" "${RROOT}/current"
cat > "${RROOT}/compose.env" <<ENV
NAPPLET_CVM_ROOT=${RROOT}
NAPPLET_CVM_PROJECT=${PROJECT}
NAPPLET_CVM_BIND=${BIND}
NAPPLET_CVM_REVISION=${REVISION}
ENV
REALM="$(jq -r .realm "${RROOT}/config/service.json")"
PROFILE=(); [[ "${REALM}" == test ]] && PROFILE=(--profile test-rails)

compose up -d --wait postgres
compose exec -T postgres pg_restore -U napplet_cvm -d napplet_cvm --no-owner --exit-on-error < "${BACKUP}/database.dump"
compose "${PROFILE[@]}" up -d --wait relay engine
docker save napplet-cvm/dev-worker:development napplet-cvm/dev-publication:development | compose exec -T engine docker --host unix:///run/cvm-docker/docker.sock load -q
[[ "${REALM}" == test ]] && compose "${PROFILE[@]}" up -d test-mint test-wallet
compose run --rm --no-deps --entrypoint bun cvm scripts/migrate.ts --check
compose up -d --no-deps cvm
for _ in $(seq 120); do
  state="$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q cvm)" 2>/dev/null || true)"
  [[ "${state}" == healthy ]] && break; sleep 5
done
[[ "${state}" == healthy ]] || { compose logs --tail 40 cvm >&2; echo "restored service did not become healthy" >&2; exit 4; }
ready=$(date +%s)
install -d -m 0700 "${RROOT}/data/storage/.restore-evidence"
cp "${BACKUP}/counts.tsv" "${BACKUP}/manifest.json" "${RROOT}/data/storage/.restore-evidence/"
compose exec -T cvm bun scripts/verify-restore.ts --counts /var/lib/napplet-cvm/.restore-evidence/counts.tsv --manifest /var/lib/napplet-cvm/.restore-evidence/manifest.json

if [[ -n "${FLOW_DIR}" ]]; then
  ORIGIN="$(jq -r .origins.public "${RROOT}/config/service.json")"
  docker run --rm --network "${PROJECT}_default" -v "$(realpath -e "${FLOW_DIR}")":/flow --entrypoint bun "napplet-cvm/service:${REVISION}" \
    scripts/service-flow.ts --phase reopen --origin "${ORIGIN}" --identity /flow/user.key --state /flow/flow-state.json --resolve http://cvm:8080 --relay ws://relay:8080
fi
echo "NAPPLET_CVM_RESTORE_TEST_OK backup=${BACKUP} revision=${REVISION} realm=${REALM} restore_seconds=$((ready - started)) total_seconds=$(( $(date +%s) - started ))"
if [[ "${NAPPLET_CVM_RESTORE_KEEP:-0}" != 1 ]]; then compose "${PROFILE[@]}" down -v --remove-orphans >/dev/null; rm -rf -- "${RROOT}"; fi
