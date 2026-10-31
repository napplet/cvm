#!/bin/sh
set -eu
# This is the only privileged process in the production-worker image.  It
# establishes the per-lease writable filesystem before the untrusted workload
# exists, then irreversibly drops every capability.  A provider which denies
# the mount is intentionally ineligible: an overlay workspace is not a quota.
[ "$(id -u)" = 0 ] || exit 126
# Providers differ in whether the image ENTRYPOINT precedes their explicit
# command. Normalize only our own immutable wrapper before dropping privilege.
if [ "${1-}" = /usr/local/bin/napplet-cvm-bootstrap ]; then shift; fi
command -v mount >/dev/null 2>&1 || exit 126
command -v findmnt >/dev/null 2>&1 || exit 126
command -v setpriv >/dev/null 2>&1 || exit 126
command -v mountpoint >/dev/null 2>&1 || exit 126
# Provider exec calls start as the image user.  Enter a fresh network namespace
# before any untrusted command, bring back loopback for Chromium's local test
# server, and fail closed if the provider/kernel disallows namespace creation.
# A fresh namespace has no external interfaces or routes; this is stronger than
# a provider metadata flag and is independently observed by the trusted probe.
if [ "${NAPPLET_CVM_NETWORK_NAMESPACE-}" != "1" ]; then
  command -v unshare >/dev/null 2>&1 || exit 126
  exec unshare --net -- env NAPPLET_CVM_NETWORK_NAMESPACE=1 "$0" "$@"
fi
NET=/toolchain/bin/busybox
[ -x "$NET" ] || exit 126
"$NET" ip link set lo up || exit 126
ACTIVE_NON_LOOPBACK=$("$NET" ip -o link show | "$NET" grep -v '^1: lo:' | "$NET" grep '<[^>]*UP' || true)
[ -z "$ACTIVE_NON_LOOPBACK" ] || exit 126
[ -z "$("$NET" ip route show default)" ] || exit 126
mount_bounded() {
  path=$1 size_limit=$2 options=$3 owner=${4-65532} mode=${5-0700}
  mkdir -p "$path"
  if ! mountpoint -q "$path"; then
    mount -t tmpfs -o "size=$size_limit,mode=$mode,nosuid,nodev,$options" tmpfs "$path" || exit 126
  fi
  [ "$(findmnt -n -o FSTYPE --target "$path")" = "tmpfs" ] || exit 126
  size=$(findmnt -n -o SIZE --bytes --target "$path")
  [ "$size" -gt 0 ] && [ "$size" -le "$size_limit" ] || exit 126
  chown "$owner:$owner" "$path" || exit 126
  chmod "$mode" "$path" || exit 126
}
# Generated work, HOME caches, and /tmp are all independently bounded.  Do
# not accept the image overlay for any writable path: it is not a quota.
# The generated build deliberately executes JavaScript and architecture-native
# build helpers from this quota-controlled directory.  noexec cannot protect a
# workload that must run its own build graph; the boundary is the bounded tmpfs
# plus non-root/no-caps/no-new-privileges and verified network denial.  HOME
# and /tmp do not execute project tooling and remain noexec.
# Status queries share the existing mount with running builds. Never narrow
# its traversal permissions even momentarily: a concurrent compiler read can
# otherwise receive EACCES and report an immutable library as missing.
mount_bounded /workspace 536870912 exec 0 1777
# Sticky, root-owned parent prevents generated code from replacing a trusted
# job's project directory while still permitting its ordinary workspace files.
[ ! -L /workspace/jobs ] || exit 126
mkdir -p /workspace/jobs
chown 0:0 /workspace/jobs
chmod 0755 /workspace/jobs
mount_bounded /run/napplet-cvm-jobs 67108864 noexec 0
mount_bounded /home/napplet 67108864 noexec
mount_bounded /tmp 67108864 noexec
mount_bounded /var/tmp 67108864 noexec
mount_bounded /work 67108864 noexec
mount_bounded /run/lock 16777216 noexec
# Chromium may use POSIX shared memory; keep that writable surface separately
# quota-bound instead of inheriting Docker's provider-sized /dev/shm default.
mount_bounded /dev/shm 67108864 exec
# Do not leak image/build-time or provider variables to generated code.  The
# worker's ready check consumes this exact small environment as evidence.
policy=${NAPPLET_CVM_POLICY_VERSION-}
[ -n "$policy" ] || exit 126
# Keep only the immutable, timer-only lease supervisor root-owned. A workload
# sharing its UID could otherwise SIGSTOP it and evade Fly's lifetime bound.
# It receives no source, stdin instructions, provider credentials, or shell.
if [ "$#" = 4 ] && [ "$1" = /usr/local/bin/napplet-cvm-worker ] && [ "$2" = idle ] && [ "$3" = --provider-deadline-epoch-ms ]; then
  exec env -i PATH=/usr/local/bin:/usr/bin:/bin NAPPLET_CVM_POLICY_VERSION="$policy" /usr/local/bin/bun /usr/local/bin/napplet-cvm-worker idle --provider-deadline-epoch-ms "$4"
fi
# Only the immutable fixed-operation supervisor retains privilege. Its private
# tmpfs is unreadable to the generated UID; it never executes caller argv.
if [ "${1-}" = /usr/local/bin/napplet-cvm-job ]; then
  shift
  case "${1-}" in put|start|status|artifact|fence|fence-status|restore-plan|restore-put|restore|restore-repair|restore-status) ;; *) exit 126 ;; esac
  exec env -i PATH=/usr/local/bin:/usr/bin:/bin NAPPLET_CVM_POLICY_VERSION="$policy" /usr/local/bin/bun /usr/local/bin/napplet-cvm-job "$@"
fi
exec env -i HOME=/home/napplet CI=1 PATH=/toolchain/bin:/toolchain/pnpm:/toolchain/node_modules/.bin:/usr/local/bin:/usr/bin:/bin PLAYWRIGHT_BROWSERS_PATH=/toolchain/ms-playwright NAPPLET_CVM_POLICY_VERSION="$policy" setpriv --reuid 65532 --regid 65532 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs -- "$@"
