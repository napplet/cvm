# Responsive application verification — 2026-10-16

Implementation: `8023241`.

## Responsive matrix

`bun scripts/dev.ts test --case=responsive` passed. It renders the real public view components with read-only transport fixtures and no external signer/discovery connections. It needs no running Docker/CVM services and makes no generation or publication requests.

14 states × 19 viewports = **266 checks**: idea, setup, generation, verified builder, expanded preview, blocked revision, connection settings, Nostr sign-in/QR, collection, empty collection, collection error, publication form, publication review, and propagation failure.

Widths: 280, 320, 360, 390, 540, 600, 768, 850, 1000, 1001, 1024, 1100, 1280, 1440, 1920 and 2560 CSS pixels. Additional short viewports: 844×390, 568×320 and 320×320. Supported minimum width: 320; 280 is an additional stress check.

Assertions check document/body/frame/content/dialog widths, offscreen controls, minimum 44px targets (allowing subpixel rounding), hit-tested action reachability, outer frame position, short viewport space, long unbroken titles/errors/addresses, and sandbox containment. A deliberately 1800px-wide iframe document does not widen the parent. The iframe counter and revision draft survive repeated resizing and collection navigation.

Detected and corrected during this matrix: an absolutely positioned accessible label escaped its scroll container in landscape; sticky detail progress covered preview controls after resizing. The content region now establishes its containing block and detailed progress scrolls with it. Primary navigation and connection status remain outside that region.

## Composed regression checks

- `product-view.e2e.ts`: passed state explanations, focus, navigation, responsive touch targets and reduced motion.
- `product-workspace.e2e.ts`: passed the generation/revision/recovery journey with a fixture model and real local relay/Cashu/SQL/Docker/Paja. Five expected inference calls; deliberate invalid-TypeScript revision emitted the expected failed-build event.
- `returning-projects.e2e.ts`: passed ownership, original anonymous work, live work while navigating, browser history, fresh-browser reopening and restart persistence.
- `static-cvm-publication.e2e.ts`: passed separate-origin static hosting, private administration, signers including real NIP-46, failed/successful mirroring, signed publication and restart persistence.
- `bun scripts/build-workspace.ts` and `git diff --check`: passed.
- TypeScript: same 424 existing diagnostic signatures; no additions. Global typecheck remains failing at its baseline.
- Root package.json and bun.lock SHA-256 pins unchanged.
- Default service: waited for the active request to settle, confirmed zero active metered actions, then restarted while preserving its saved chatgpt-oauth mode, data and port 49371. A real browser smoke passed direct collection navigation, draft/back/forward continuity and frame bounds at 280×560, 320×568, 320×320, 844×390 and 1440×900.

Local logs: `/tmp/cvm-frame-{responsive,responsive-launcher,view,product,projects,publication,typecheck}.log`. Screenshots of both page tops and action positions: `.local/development-gui-evidence/responsive/`.
