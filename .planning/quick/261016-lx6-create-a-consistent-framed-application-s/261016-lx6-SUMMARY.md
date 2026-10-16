---
status: complete
completed: 2026-10-16
commit: 8023241
---

# A consistent responsive application frame

The public workspace now uses a bounded application frame with persistent primary navigation and connection status. All creation, builder, collection and publication content uses one scrolling region. The document stays fixed, and the iframe's content remains contained independently. Rounded desktop chrome becomes edge-to-edge on phones and short viewports.

Fixed rows reflow, project titles use a three-line summary with full accessible text/tooltip, addresses and diagnostics wrap, dialogs scroll within their available height, and mobile form fields retain readable sizes. Small-screen collection and creation views remove decorative copy before reducing controls. Detailed progress scrolls with the workspace instead of covering actions. Routes scroll the shared content region and preserve the mounted preview and drafts.

Added `bun scripts/dev.ts test --case=responsive`, also included in `--case=full`. The standalone case needs no CVM or Docker services. It passes 266 checks across 14 view states and 19 viewports, including widths 280–2560 and heights down to 320. The supported minimum width is 320 CSS pixels; 280 is additional stress coverage.

Product view, full product journey, returning projects and static CVM publication suites also passed, along with the static build and live default-service smoke. No new TypeScript diagnostic signatures; the repository retains its existing 424 diagnostics. Root dependency pins unchanged. Browser fixtures did not invoke a real model or publish under the user's identity.

Code pushed to main as `8023241`. The default service is ready at `http://127.0.0.1:49371`, with saved chatgpt-oauth mode and persistent data retained. An active generation was allowed to settle before the restart. Reload the existing tab to receive the updated static interface while retaining its browser identity. Production verification remains deferred.
