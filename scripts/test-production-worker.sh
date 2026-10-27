#!/bin/sh
# No-effect local production-worker acceptance.  It deliberately uses ordinary
# Docker networking: the trusted bootstrap must create the denied inner netns.
set -eu
image=${1:-napplet-cvm-production-worker:local}
name="napplet-cvm-production-worker-test-$$"
report=${NAPPLET_CVM_WORKER_REPORT:-/tmp/napplet-cvm-production-worker-report.json}
lease=$(printf 'a%.0s' $(seq 1 64)); image_hash=$(printf 'b%.0s' $(seq 1 64)); toolchain=$(printf 'c%.0s' $(seq 1 64))
deadline=$(( $(date +%s) * 1000 + 600000 ))
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run --rm --cap-add SYS_ADMIN --cap-add NET_ADMIN -e NAPPLET_CVM_POLICY_VERSION=production-worker-policy-2026-10-27 "$image" /usr/local/bin/napplet-cvm-worker ready --session-lease-sha256 "$lease" --provider-image "registry.example/worker@sha256:$image_hash" --toolchain-sha256 "$toolchain" --provider-deadline-epoch-ms "$deadline" > "$report"
docker run -d --name "$name" --cap-add SYS_ADMIN --cap-add NET_ADMIN -e NAPPLET_CVM_POLICY_VERSION=production-worker-policy-2026-10-27 "$image" /bin/sh -ec 'mkdir -p /workspace/.napplet-cvm; printf "%s" "{\"files\":[{\"path\":\"src/main.ts\",\"content\":\"import { runtimeHasDomain } from '\''./domain-availability.js'\''; const optional = runtimeHasDomain('\''intent'\''); document.body.textContent = optional ? '\''hello'\'' : '\''offline'\'';\"}]}" > /workspace/.napplet-cvm/source.json; /usr/local/bin/napplet-cvm-worker build-source --source /workspace/.napplet-cvm/source.json --active-deadline-epoch-ms '"$deadline"
status=$(docker wait "$name")
docker logs "$name" >> "$report"
[ "$status" = 0 ]
