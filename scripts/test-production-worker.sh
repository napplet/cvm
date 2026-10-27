#!/bin/sh
# Bounded, no-effect production-worker image validation.  The TypeScript
# harness owns container names, timeouts, report retention, and JSON parsing.
set -eu
exec bun "$(dirname "$0")/test-production-worker.ts" "$@"
