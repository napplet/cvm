---
type: quick
status: complete
---

# applet.broker user experience

## Goal and acceptance

Deliver a polished user-facing experience on top of the working generation service. The first deployment brand is **applet.broker**; the reusable project is intended for eventual **@napplet/cvm** publication. Deployment and package publication are future release operations, not substitutes for verifying the UX locally.

1. A guided flow presents one main decision at a time: describe an idea, confirm model/budget, create and refine. Preserve drafts through account redirects and reloads. Existing sign-in remains reusable.
2. Progress is at the top, driven by real service events. Distinguish preparing, generating, building/checking, verified completion, paused work, failed work, uncertain outcomes and stale updates. Keep granular execution details available without dominating the product flow.
3. The verified preview is the primary work surface. Revision input appears as a chat composer directly beside it on desktop and directly below on mobile. Conversation bubbles record requests and truthful outcomes. Preserve the last good preview on failure and show version history without artifact hashes in the primary UI.
4. The original development console remains available at `/dev`, sharing execution behavior. `/` becomes the product experience. The development environment remains clearly identified; local test funding and subscription usage are described honestly. Publication is not claimed or simulated.
5. Keyboard operation, visible focus, readable contrast, reduced motion, responsive layouts and accessible status/error announcements work at phone, tablet and desktop widths. Preserve browser-key custody, relay commands, budget authorization, replay protection, and opaque preview isolation.
6. Verify the new UI with real browser + relay + SQL + Docker + Paja generation/revision, navigation and reload recovery, failure feedback, responsive screenshots and existing console regressions. Finish with the actual development service running the new UI and saved ChatGPT sign-in intact.

## Implementation

- Inspect and reuse the current browser controller and client. Extract presentation seams rather than duplicate generation, funding or continuity logic.
- Build the branded guided layout and adjacent revision chat; centralize display-state and honest progress projection.
- Keep model/account controls in a settings surface and detailed execution in an expandable view. Automatically connect the browser identity in the product flow; test-fund only as part of an explicit create action when needed.
- Add focused tests for product transitions and real composed journeys, and inspect rendered screenshots at 390, 768 and 1440 widths. Fix issues found by those checks.
- Document routes, development behavior and the future reusable package/deployment boundary. Record completion evidence and commits in GSD state.

## Design direction

Confirmed by the user: a warm light workspace with restrained green accents, generous reading space, compact controls, clear typography and a large preview. Avoid displaying private identifiers or low-level build details in the main product flow.

## Plan review

The existing service already supplies signed progress and durable artifact/session facts, so no new public HTTP generation route is needed. UI changes must not create a second payment or model orchestration path. Product and console browser journeys will be verified separately. Production deployment prerequisites remain deferred as previously requested.
