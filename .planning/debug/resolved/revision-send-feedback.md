---
status: resolved
trigger: "I am not able to send the revision and it is not clear why"
created: 2026-10-16
updated: 2026-10-16
---

## Symptoms

Expected: A typed revision can be sent when eligible; otherwise its blocking reason and next action appear beside the composer.
Actual: Screenshot shows nonempty revision text, a disabled send arrow, and only the keyboard shortcut hint. A notice is partly visible below the workspace.
Reproduction: Restore a verified preview whose newer action has an unknown outcome, or enter any other disabled revision state.

## Current Focus

Root cause confirmed: ProductWorkspace collapsed connection, running, recovery, session, version-selection and empty-input checks into one disabled boolean. The composer never rendered the reason; saved unresolved sessions explained the block only in a lower notice.

Resolution: Each disabled state now explains its reason beside Send and offers the relevant action. Saved blocked-session drafts remain editable. Check status requests only the signed, owner-scoped session state and refreshes availability without retrying generation. A ready authoritative state re-enables sending and clears the obsolete notice.

## Evidence

- Graph search has no indexed ProductWorkspace nodes; inspected its current source directly.
- syncControls disables revise for eight different conditions but only renders the static shortcut hint.
- sessionState usage_unknown/billing_invariant_failed blocks revisions and shows a notice after the workspace. The local database retains usage_unknown sessions with a verified version; the screenshot alone does not identify which session is open.
- Existing product e2e confirms an unresolved outcome stays blocked across reload. It does not assert any explanation at the composer.
- Browser connector is unavailable (transport closed); no direct observation of the user's current tab is possible.
- Root dependency pins and existing unknown operations must remain unchanged. No ledger mutation or automatic generation retry is authorized by this fix.

## Verification

- `bun tests/dev-ui/product-view.e2e.ts` passed: connection/recovery/empty-input/unknown/accounting explanations, editable blocked draft, preserved draft, safe status errors, no send on status check, re-enabled Send after authoritative resolution, responsive touch targets and focus.
- `bun tests/dev-ui/product-workspace.e2e.ts` passed through real local relay, Cashu, SQL, Docker and Paja with a fixture model. An unknown-outcome revision remains fenced across reload; signed Check status does not add an inference or discard the draft. Running and earlier-version blockers are visible. Five expected fixture inference calls; deliberate invalid TypeScript produces the expected failed-build event.
- `returning-projects.e2e.ts` and `static-cvm-publication.e2e.ts` passed alongside the contextual application navigation change.
- Static build and `git diff --check` passed. Final TypeScript diagnostics match the existing 424-error baseline by file/message signature; no clean global typecheck is claimed.
- Default service restarted only after querying zero active metered actions. Same URL, state and chatgpt-oauth mode retained. Read-only live browser navigation smoke passed.
- The screenshot alone cannot establish the user's exact session. Historical unknown provider outcomes remain unresolved and fenced; this UI fix neither clears accounting uncertainty nor automatically retries those requests.

Implementation: `3a12c93`. Related navigation task: `quick/261016-jn3-make-workspace-navigation-feel-like-an-a`.
