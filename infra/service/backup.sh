#!/usr/bin/env bash
# Consistent napplet-cvm snapshot into a Docker volume that the host's backup
# system (Borg on homelab) collects. Order matters: the PostgreSQL dump is a
# single transactionally consistent snapshot; immutable storage objects are
# copied afterwards, so every object referenced by the dump is present.
#   backup.sh <root> [volume]
set -euo pipefail
ROOT="${1:?root required}"
VOLUME="${2:-napplet_cvm_backup}"
KEEP="${NAPPLET_CVM_BACKUP_KEEP:-3}"
# shellcheck disable=SC1091
source "${ROOT}/compose.env"
compose() { docker compose -p "${NAPPLET_CVM_PROJECT}" --env-file "${ROOT}/compose.env" -f "${ROOT}/current/infra/service/compose.yaml" "$@"; }

docker volume create "${VOLUME}" >/dev/null
DEST="$(docker volume inspect -f '{{.Mountpoint}}' "${VOLUME}")"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="${DEST}/.partial-${STAMP}"
trap 'rm -rf -- "${WORK}"' EXIT
install -d -m 0700 "${WORK}"

compose exec -T postgres pg_dump -U napplet_cvm -d napplet_cvm --format=custom --no-owner --no-privileges > "${WORK}/database.dump"
compose exec -T postgres psql -U napplet_cvm -d napplet_cvm -Atc "
  SELECT table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text
  FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1" > "${WORK}/counts.tsv"
test -s "${WORK}/database.dump" && test -s "${WORK}/counts.tsv"
tar -C "${ROOT}/data" -cf "${WORK}/storage.tar" storage $(cd "${ROOT}/data" && ls -d test-mint test-mint-2 test-wallet 2>/dev/null || true)
tar -C "${ROOT}" -cf "${WORK}/state.tar" config secrets deployed.json
STATUS="$(compose exec -T cvm bun -e "const r=await fetch('http://127.0.0.1:8080/health'); console.log(await r.text())" 2>/dev/null || echo '{}')"
PUBKEY="$(compose exec -T cvm cat /var/lib/napplet-cvm/service-pubkey 2>/dev/null || true)"
cat > "${WORK}/manifest.json" <<JSON
{"version":1,"createdAt":"${STAMP}","revision":"${NAPPLET_CVM_REVISION}","realm":"$(jq -r .realm "${ROOT}/config/service.json")","servicePubkey":"${PUBKEY}","health":${STATUS}}
JSON
(cd "${WORK}" && sha256sum database.dump counts.tsv storage.tar state.tar manifest.json > SHA256SUMS)
chmod -R go-rwx "${WORK}"
mv "${WORK}" "${DEST}/${STAMP}"
trap - EXIT
ln -sfn "${STAMP}" "${DEST}/latest"
ls -1d "${DEST}"/2* | sort | head -n -"${KEEP}" | xargs -r rm -rf --
echo "NAPPLET_CVM_BACKUP_OK path=${DEST}/${STAMP} revision=${NAPPLET_CVM_REVISION} bytes=$(du -sb "${DEST}/${STAMP}" | cut -f1)"
