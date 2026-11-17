---
status: fixing
trigger: resolve issues on homelab.
created: 2026-11-17
updated: 2026-11-17
---

## Symptoms

Expected: stable ContextVM relay subscriptions, working configured model authentication, and bounded useful runtime diagnostics.
Actual: repeated relay liveness timeouts and pool rebuilds; one recorded model HTTP 401; detached development server discards stdout/stderr and records only startup heartbeats.
Timeline: current deployment has been running since November 10; fresh November 17 inspection confirms 617 timeout/rebuild cycles in 24 hours.
Reproduction: observe an idle active ContextVM subscription for longer than the 120-second ping interval and 20-second timeout.

## Current Focus

hypothesis: confirmed protocol incompatibility: the deployed relay ignores limit-zero subscriptions; the detached launcher suppresses the development server's runtime diagnostics.
next_action: publish the positive-limit SDK probe and safe progress observer; configure the operator deployment to forward diagnostics and verify live recovery.

## Evidence

- Current app containers report healthy with no restart loop; API relay warning persists independently of generation traffic.
- SDK uses an ids filter with limit zero and waits only for EOSE before rebuilding the pool.
- scripts/dev.ts launches a detached child with both output streams ignored and stops its startup heartbeat after twelve samples.
- A raw WebSocket comparison received no response to limit zero and immediate EOSE to limit one.
- The regression failed before the patch: four connections instead of one over 300ms. The positive-limit patch preserves the original connection.
- Safe progress observations contain only validated tool/stage/state enums; callback failure cannot change the authoritative response.
- Configured operator model credential is rejected as expired_secret_key; replacement requested separately without exposing the credential.

## Resolution

Dependency patch and bounded progress observer implemented. Focused progress/liveness/shutdown tests and the pinned TypeScript compiler pass. Live deployment and credential replacement remain pending. Deployment-specific evidence belongs in the operator repository.
