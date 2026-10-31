#!/bin/sh
set -eu
refuse() { printf '%s\n' "CVM_BOOTSTRAP_REFUSED:$1" >&2; exit 126; }
# This is the only privileged process in the production-worker image.  It
# establishes the per-lease writable filesystem before the untrusted workload
# exists, then irreversibly drops every capability.  A provider which denies
# the mount is intentionally ineligible: an overlay workspace is not a quota.
[ "$(id -u)" = 0 ] || refuse BOOTSTRAP_UID
# Providers differ in whether the image ENTRYPOINT precedes their explicit
# command. Normalize only our own immutable wrapper before dropping privilege.
if [ "${1-}" = /usr/local/bin/napplet-cvm-bootstrap ]; then shift; fi
command -v mount >/dev/null 2>&1 || refuse TOOL_MOUNT
command -v findmnt >/dev/null 2>&1 || refuse TOOL_FINDMNT
command -v setpriv >/dev/null 2>&1 || refuse TOOL_SETPRIV
command -v mountpoint >/dev/null 2>&1 || refuse TOOL_MOUNTPOINT
command -v stat >/dev/null 2>&1 || refuse TOOL_STAT
# Provider exec calls start as the image user.  Enter a fresh network namespace
# before any untrusted command, bring back loopback for Chromium's local test
# server, and fail closed if the provider/kernel disallows namespace creation.
# A fresh namespace has no external interfaces or routes; this is stronger than
# a provider metadata flag and is independently observed by the trusted probe.
if [ "${NAPPLET_CVM_NETWORK_NAMESPACE-}" != "1" ]; then
  command -v unshare >/dev/null 2>&1 || refuse TOOL_UNSHARE
  exec unshare --net -- env NAPPLET_CVM_NETWORK_NAMESPACE=1 "$0" "$@" || refuse NETWORK_NAMESPACE
fi
# The provider must create this worker with its own private mount namespace and
# a read-only image root. Do not create a transient nested mount namespace:
# fixed-operation `put`/`status` calls must share the same trusted job tmpfs.
# A writable overlay is never repaired in-process; absent the native launch
# boundary, fail before mounting or executing anything.
ROOT_OPTIONS=$(findmnt -n -o OPTIONS --target /) || refuse ROOT_OPTIONS_QUERY
ROOT_PROPAGATION=$(findmnt -n -o PROPAGATION --target /) || refuse ROOT_PROPAGATION_QUERY
case ",$ROOT_OPTIONS," in *,ro,*) ;; *) refuse ROOT_NOT_READONLY ;; esac
case "$ROOT_PROPAGATION" in private) ;; *) refuse ROOT_NOT_PRIVATE ;; esac
NET=/toolchain/bin/busybox
[ -x "$NET" ] || refuse TOOL_NETWORK
"$NET" ip link set lo up || refuse NETWORK_LOOPBACK
ACTIVE_NON_LOOPBACK=$("$NET" ip -o link show | "$NET" grep -v '^1: lo:' | "$NET" grep '<[^>]*UP' || true)
[ -z "$ACTIVE_NON_LOOPBACK" ] || refuse NETWORK_LINK
[ -z "$("$NET" ip route show default)" ] || refuse NETWORK_ROUTE
mount_bounded() {
  stage=$1 path=$2 size_limit=$3 options=$4 owner=${5-65532} mode=${6-0700}
  mkdir -p "$path" || refuse "MOUNT_${stage}_TARGET"
  if ! mountpoint -q "$path"; then
    mount -t tmpfs -o "size=$size_limit,mode=$mode,nosuid,nodev,$options" tmpfs "$path" || refuse "MOUNT_${stage}_CREATE"
  fi
  [ "$(findmnt -n -o FSTYPE --target "$path")" = "tmpfs" ] || refuse "MOUNT_${stage}_FSTYPE"
  size=$(findmnt -n -o SIZE --bytes --target "$path") || refuse "MOUNT_${stage}_SIZE_QUERY"
  case "$size" in ''|*[!0-9]*) refuse "MOUNT_${stage}_SIZE" ;; esac
  [ "$size" -gt 0 ] && [ "$size" -le "$size_limit" ] || refuse "MOUNT_${stage}_SIZE"
  chown "$owner:$owner" "$path" || refuse "MOUNT_${stage}_OWNER"
  chmod "$mode" "$path" || refuse "MOUNT_${stage}_MODE"
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
mount_bounded WORKSPACE /workspace 536870912 exec 0 1777
# Sticky, root-owned parent prevents generated code from replacing a trusted
# job's project directory while still permitting its ordinary workspace files.
[ ! -L /workspace/jobs ] || refuse WORKSPACE_JOBS_SYMLINK
mkdir -p /workspace/jobs || refuse WORKSPACE_JOBS_TARGET
chown 0:0 /workspace/jobs || refuse WORKSPACE_JOBS_OWNER
chmod 0755 /workspace/jobs || refuse WORKSPACE_JOBS_MODE
mount_bounded JOBS /run/napplet-cvm-jobs 67108864 noexec 0
mount_bounded HOME /home/napplet 67108864 noexec
mount_bounded TMP /tmp 67108864 noexec
mount_bounded VARTMP /var/tmp 67108864 noexec
mount_bounded WORK /work 67108864 noexec
mount_bounded LOCK /run/lock 16777216 noexec
# Chromium may use POSIX shared memory; keep that writable surface separately
# quota-bound instead of inheriting Docker's provider-sized /dev/shm default.
mount_bounded SHM /dev/shm 67108864 exec
# The image overlay is never an allowed writable surface.  Seal every existing
# non-policy mount read-only in the worker's private mount namespace, leaving
# only the exact bounded tmpfs mounts above writable.  Mount metadata, not
# UID-based access, is the authority: an unwritable mount root can still have
# a writable descendant.
seal_base_mounts() {
  masked_file_label() {
    # This is the fixed Moby masked-file subset. Directory masks are never
    # accepted here, and an unlisted path must remain an unknown-RW refusal.
    case "$1" in
      /proc/interrupts) printf '%s' PROC_INTERRUPTS ;;
      /proc/kcore) printf '%s' PROC_KCORE ;;
      /proc/keys) printf '%s' PROC_KEYS ;;
      /proc/latency_stats) printf '%s' PROC_LATENCY_STATS ;;
      /proc/sched_debug) printf '%s' PROC_SCHED_DEBUG ;;
      /proc/timer_list) printf '%s' PROC_TIMER_LIST ;;
      /proc/timer_stats) printf '%s' PROC_TIMER_STATS ;;
      *) return 1 ;;
    esac
  }
  seal_masked_file() {
    target=$1 label=$2
    [ ! -L "$target" ] || refuse "SEAL_MASK_${label}_SYMLINK"
    [ "$(stat -c '%F:%t:%T' "$target")" = "character special file:1:3" ] || refuse "SEAL_MASK_${label}_TYPE"
    mount -o remount,bind,ro "$target" || refuse "SEAL_MASK_${label}_REMOUNT"
    mask_options=$(findmnt -n -o OPTIONS --target "$target") || refuse "SEAL_MASK_${label}_OPTIONS"
    case ",$mask_options," in *,ro,*) ;; *) refuse "SEAL_MASK_${label}_NOT_READONLY" ;; esac
  }
  mount_label() {
    # Report only a fixed Linux/Docker pseudo-mount class. Never echo an
    # arbitrary provider mount target, source, option string, or environment.
    case "$1" in
      /proc/bus) printf '%s' PROC_BUS ;;
      /proc/fs) printf '%s' PROC_FS ;;
      /proc/irq) printf '%s' PROC_IRQ ;;
      /proc/sys) printf '%s' PROC_SYS ;;
      /proc/sysrq-trigger) printf '%s' PROC_SYSRQ ;;
      /proc/acpi) printf '%s' PROC_ACPI ;;
      /proc/asound) printf '%s' PROC_ASOUND ;;
      /proc/interrupts) printf '%s' PROC_INTERRUPTS ;;
      /proc/kcore) printf '%s' PROC_KCORE ;;
      /proc/keys) printf '%s' PROC_KEYS ;;
      /proc/latency_stats) printf '%s' PROC_LATENCY_STATS ;;
      /proc/sched_debug) printf '%s' PROC_SCHED_DEBUG ;;
      /proc/scsi) printf '%s' PROC_SCSI ;;
      /proc/timer_list) printf '%s' PROC_TIMER_LIST ;;
      /proc/timer_stats) printf '%s' PROC_TIMER_STATS ;;
      /sys/firmware) printf '%s' SYS_FIRMWARE ;;
      /sys/devices/virtual/powercap) printf '%s' SYS_POWERCAP ;;
      /sys/devices/system/cpu/cpu*/thermal_throttle) printf '%s' SYS_CPU_THERMAL ;;
      /run) printf '%s' RUN ;;
      /run/secrets) printf '%s' RUN_SECRETS ;;
      *) printf '%s' OTHER ;;
    esac
  }
  list=/run/napplet-cvm-jobs/.mounts-before-seal
  findmnt -rn -o TARGET,OPTIONS > "$list" || refuse SEAL_MOUNTINFO
  while IFS=' ' read -r target options; do
    [ -n "$target" ] && [ -n "$options" ] || refuse SEAL_MOUNTINFO_ROW
    case "$target" in
      /workspace|/run/napplet-cvm-jobs|/home/napplet|/tmp|/var/tmp|/work|/run/lock|/dev/shm) continue ;;
      # These are the complete Docker/Linux base mounts permitted before they
      # are sealed. Any other read-write mount is an injected surface and is
      # refused rather than normalized into an implicit allowlist.
      /|/proc|/dev|/dev/pts|/dev/mqueue|/sys|/sys/fs/cgroup|/etc/resolv.conf|/etc/hostname|/etc/hosts) ;;
      *) case ",$options," in
           *,rw,*) if label=$(masked_file_label "$target"); then seal_masked_file "$target" "$label"; else refuse "SEAL_UNKNOWN_RW_MOUNT_$(mount_label "$target")"; fi ;;
         esac
         continue ;;
    esac
    case ",$options," in
      *,rw,*) mount -o remount,ro "$target" || refuse SEAL_BASE_REMOUNT ;;
    esac
  done < "$list"
  rm -f "$list" || refuse SEAL_CLEANUP
}
seal_base_mounts
# Do not leak image/build-time or provider variables to generated code.  The
# worker's ready check consumes this exact small environment as evidence.
policy=${NAPPLET_CVM_POLICY_VERSION-}
[ -n "$policy" ] || refuse POLICY_VERSION
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
