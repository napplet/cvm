---
type: quick
status: complete
---

# applet.broker guided workspace

Delivered the user-facing **applet.broker** experience at `/`, retaining the original diagnostic console at `/dev`. The user chose **warm, light, minimal**. Implementation commits: `bc9bf2a` (verified-base revision recovery) and `73e350d` (product workspace, tests and documentation).

## Result

- Guided idea → model/budget review → preview/refinement flow, with browser connection and explicitly initiated local test funding handled automatically.
- Sticky top progress driven by actual service stages; provider mode, stale updates, stopped/uncertain outcomes and detailed execution remain visible without overwhelming the workspace.
- Large sandboxed preview alongside revision chat, readable version selection, older-version viewing, persistent tab drafts/conversation, keyboard submission, and responsive layouts. Paja developer chrome is hidden only in product presentation; `/dev` retains its controls.
- Saved ChatGPT sign-in is reused. OAuth redirects retain drafts and the initiating surface; account errors open settings. First-use consent is visible outside the settings dialog.
- Interrupted requests persist their exact authorized envelope. Explicit recovery reuses the original admission and idempotency key, preventing duplicate inference/charges. Unresolved sessions remain blocked from revision after reload.
- A settled failed revision can be followed by a new explicit revision from the last verified artifact. Active, usage-unknown and billing-invariant states remain fenced. The memory store now projects the newest action like SQL instead of hiding same-version failures.
- README/runbook document product and console routes, local test accounting, recovery, and the future `@napplet/cvm` package / applet.broker deployment boundary.

## Verification

See `261016-coz-VERIFICATION.md` for the acceptance matrix and evidence. Product and console composed browser journeys passed against actual relay, Cashu, PostgreSQL, Docker, verification and Paja. OAuth/inference were fixtures for these automated runs; no new live model request was needed. The standard service is running at **http://127.0.0.1:49371**, with the existing signed-in ChatGPT account and `gpt-6.1-sol` selection intact.

## Deviations resolved during verification

- Real failure-path testing exposed the service rejecting revisions after a settled failed build. Added a narrow verified-base exception with regression tests, preserving original-operation and unknown-usage fences.
- The in-memory session projection sorted by completed version and concealed failed/unresolved actions at the same version. It now observes insertion-ordered latest action, matching the existing SQL projection.
- An existing admission concurrency test assumed a zero-delay timer was sufficient for async cryptography. It now waits for the actual capacity entry signal. The outer test watchdog was separated from the unchanged 5ms provider deadline.
- Under heavy workstation load, host Chromium used its own 30s shutdown fallback. The previous 30s probe wrapper killed it just before cleanup completed. Host readiness now allows 55s for the 20s launch plus 30s cleanup, and the launcher allows 120s for all startup probes. Generation/admission budgets and security checks are unchanged.

## Limits

Repository-wide TypeScript checking still reports the same **426 diagnostics** as an isolated checkout of pre-change HEAD; normalized comparison found **zero new diagnostics**. Production hosting, public onboarding/payments, publication, and package release remain deferred. Existing optional-domain/Paja conformance limitations remain documented; hiding developer chrome does not enable those capabilities.
