---
status: resolved
trigger: "All 7 CI checks are failing in 115"
created: 2026-11-10
updated: 2026-11-10
---

# Current Focus

hypothesis: Confirmed: extraction moved core tests too broadly and left workflows and fixtures bound to optional payment code.
next_action: Inspect final hosted results on PR #115 after pushing the verified repair.

# Symptoms

Expected: PR #115 checks pass using the public repository alone.
Actual: Seven failures and seven successes at a0fea4a.
Reproduction: GitHub pull_request workflows at the PR head.

# Evidence

- Four jobs fail because their entire test filter names files moved to the adapter repository.
- GUI startup and signed certification transport call compatibility entrypoints without an installed adapter.
- Documentation contract export is stale after the credit schema changes.
- Public service composition and core-value checks pass.

# Resolution

Restored portable admission, SQL, durability, recovery, publication and release
tests. Their database fixtures use PostgresCreditDatabase with explicit optional
accounting-realm selection and the same metering/continuity capability types.
Registry identity tests use opaque ports that throw if payment settlement is
attempted. Provider setup, NWC/Cashu implementations and their original tests
remain private, with a dedicated pinned CI workflow in the adapter repository.

Public payment CI covers generic adapters, exact conversion, duplicate/conflicting
grants, signed routing, free admission and real PostgreSQL upgrade/restart.
Public GUI CI builds the real worker and tests the service directly without
private payment code. It verifies an allowlisted browser's exact user charge,
interactive sandbox, preserved identity/artifact/ledger after restart and denied
unlisted identity. A second browser test checks multiple methods, direct token/fee
selection, cancellation and untrusted labels. Preview HTTP/SQL boundary tests now
use an isolated application database without mint/wallet services.

Regenerated the public contract catalog. Added a check for every literal CI test
path: Bun otherwise silently ignores missing filters when others match. No
check is disabled, and production deadlines/protection rules remain unchanged.
The restored core workload needs a ten-minute CI job budget; the five-minute
job was cancelled during its final protected-release proof. Individual test and
production operation deadlines are unchanged. Browser test origins use separate
IPv4 TLS listeners to avoid host-dependent localhost routing.

# Verification

- CI test paths: 192 verified; contract catalog: 17 tools verified.
- TypeScript: passes.
- Core admission, credits and SQL protocol: 27 pass, zero failures.
- Registry/client identity contracts: 9 pass, zero failures.
- New service and payment-selection browser tests: 2 pass, zero failures.
- Restored real preview HTTP/SQL/browser boundary test: 1 pass, 32 assertions.
- Extracted private setup/payment-client tests: 7 pass, zero failures.
- Repaired hosted runs already passed documentation, payment accounting,
  publication, service, pricing, durability images, direct worker and transport.
  PR #115 retains the exact hosted results for every pushed revision.
