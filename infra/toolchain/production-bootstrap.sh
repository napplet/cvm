#!/bin/sh
set -eu
# This is the only privileged process in the production-worker image.  It
# establishes the per-lease writable filesystem before the untrusted workload
# exists, then irreversibly drops every capability.  A provider which denies
# the mount is intentionally ineligible: an overlay workspace is not a quota.
[ "$(id -u)" = 0 ] || exit 126
command -v mount >/dev/null 2>&1 || exit 126
command -v findmnt >/dev/null 2>&1 || exit 126
command -v setpriv >/dev/null 2>&1 || exit 126
command -v mountpoint >/dev/null 2>&1 || exit 126
mount_bounded() {
  path=$1 size_limit=$2 options=$3
  mkdir -p "$path"
  if ! mountpoint -q "$path"; then
    mount -t tmpfs -o "size=$size_limit,mode=0700,nosuid,nodev,$options" tmpfs "$path" || exit 126
  fi
  [ "$(findmnt -n -o FSTYPE --target "$path")" = "tmpfs" ] || exit 126
  size=$(findmnt -n -o SIZE --bytes --target "$path")
  [ "$size" -gt 0 ] && [ "$size" -le "$size_limit" ] || exit 126
  chown 65532:65532 "$path" || exit 126
  chmod 0700 "$path" || exit 126
}
# Generated work, HOME caches, and /tmp are all independently bounded.  Do
# not accept the image overlay for any writable path: it is not a quota.
mount_bounded /workspace 536870912 noexec
mount_bounded /home/napplet 67108864 noexec
mount_bounded /tmp 67108864 noexec
# Do not leak image/build-time or provider variables to generated code.  The
# worker's ready check consumes this exact small environment as evidence.
policy=${NAPPLET_CVM_POLICY_VERSION-}
[ -n "$policy" ] || exit 126
exec env -i HOME=/home/napplet CI=1 PATH=/toolchain/bin:/toolchain/pnpm:/toolchain/node_modules/.bin:/usr/local/bin:/usr/bin:/bin PLAYWRIGHT_BROWSERS_PATH=/toolchain/ms-playwright NAPPLET_CVM_POLICY_VERSION="$policy" setpriv --reuid 65532 --regid 65532 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs -- "$@"
