---
type: quick
status: complete
completed: 2026-11-09
---

# Bounded compiler correction

Generated TypeScript failures were flattened into worker-unavailable results. The actual container path discarded the failure binding required by the existing repair coordinator. Its repair-count prefix also did not match generated repair IDs.

Compiler-only verify failures now persist a canonical bounded report on the existing worker-result row. References bind the exact failed proposal, account, session, action, version and toolchain. The API and subscription gateways receive that exact source and diagnostic as untrusted user data under the unchanged developer contract. All verification gates remain mandatory.

Container compositions permit one automatic correction when original settled spend plus another complete operation ceiling fits the signed maximum and remaining funded cap. Each attempt retains its own operation, receipt and charge. A canonical child key prevents differently keyed races. Session history uses preparation order so repeated failures offer the most recent candidate rather than an action-ID sort. Replay and restart join the same child; ambiguous provider outcomes and generic worker/conformance failures never dispatch a correction.

A signed `revise_session` may carry the owner-scoped `repairOperationId` offered by session status, including an initial failed version zero. The browser displays the new maximum and requires an approval click. Status reads never generate. Existing failures without retained compiler evidence stay unavailable until an operator independently revalidates their exact retained source; financial results and usage receipts must remain unchanged.

Shared authoring guidance uses the pinned SDK subscription types and captures checked callables in stable locals before callbacks, preventing the observed TS18046 narrowing pattern without disabling checks.

## Verification

- 111 focused tests / 595 assertions: generation, repair, provider reconciliation, revision, continuation, signed transport, source/report binding and both gateway modes.
- Four real PostgreSQL tests / 34 assertions: canonical install/upgrade/drift and durable failure replay/scoped context.
- Chromium product-view regression: explicit correction waits for the async request, survives the normal action wrapper, reflects the selected maximum and never dispatches from status.
- The existing encrypted-resume PostgreSQL regression also passes with budget timestamps, preserving compatibility with accounting schemas that lack an action timestamp (410 assertions including repair persistence).
- Whole-project TypeScript 5.9.3: clean.
- Reproduced the original compiler narrowing failure offline; capturing the checked callable passed all eight pinned worker stages including conformance and deployment dry run. No paid inference was performed for this proof.
- `git diff --check`: clean.

## Plan adjustments

Reuse the signed command fingerprint to bind the original workflow maximum, and the canonical child identity to enforce one correction. No new billing schema or generalized retry subsystem is needed. The only additive migration is `development/017_validation_failures.sql`, appended after the existing canonical sequence. Operator-specific deployment and evidence restoration remain outside the application repository.
