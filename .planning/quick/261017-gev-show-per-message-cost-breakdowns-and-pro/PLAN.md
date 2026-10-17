---
id: 261017-gev
status: complete
---

# Per-request costs and prominent project totals

1. Expose owner-scoped, paginated action costs and cumulative confirmed spend through the existing projects CVM tool. Reuse committed accounting and pinned rates, preserve unknown charges, include failed paid attempts, and store bounded request text for new actions. No provider credentials or raw responses cross the boundary.
2. Present a durable conversation with each request's actual cost and expandable usage breakdown. Make project totals prominent above the workspace, in the conversation, and on project cards. Keep estimates separate and count each action once. Support older history and small screens.
3. Verify accounting/identity boundaries and browser states, update screenshot-backed user docs, refresh the local preview, then commit and push main.

Acceptance: reload preserves costs; totals include all actions independent of pagination; replay does not double count; pending/unknown is never shown as free; breakdown reconciles to the committed charge; UI remains usable at 280px.
