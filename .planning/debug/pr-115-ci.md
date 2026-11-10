---
status: investigating
trigger: "All 7 CI checks are failing in 115"
created: 2026-11-10
updated: 2026-11-10
---

# Current Focus

hypothesis: Payment extraction did not migrate CI test entrypoints and paid launcher composition.
next_action: Preserve portable core coverage, move provider-owned CI with the adapter, regenerate contract catalog, then verify every affected check on GitHub.

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

Pending.
