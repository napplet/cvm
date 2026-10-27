#!/bin/sh
set -eu
# This is the only privileged process in the image. Provider launch policy must
# supply the bounded tmpfs; this script never falls back to an overlay.
[ "$(id -u)" = 0 ] || exit 126
[ "$(findmnt -n -o FSTYPE --target /workspace)" = "tmpfs" ] || exit 126
size=$(findmnt -n -o SIZE --bytes --target /workspace)
[ "$size" -gt 0 ] && [ "$size" -le 536870912 ] || exit 126
exec setpriv --reuid 65532 --regid 65532 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs -- "$@"
