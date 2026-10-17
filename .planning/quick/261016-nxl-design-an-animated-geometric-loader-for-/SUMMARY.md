---
status: complete
workflow: gsd-quick (inline)
---

# Explore results loader

Replaced the single outbox lookup status line with a full results-body panel. Low-contrast sage strokes travel around a slowly rotating shape that morphs between a circle, rounded square and diamond. A faint dotted orbit and soft background keep the animation quiet within the warm application frame. The panel fades and scales into view; completed results fade in as it leaves. Status copy distinguishes personal, network and older-result discovery without inventing percentages or progress.

The results area fills available height and adapts to narrow screens. Older-page requests keep existing cards visible and place the loader beneath them. Errors, identity changes and navigation settle the correct loader, while stale responses cannot dismiss a newer request. Reduced motion pauses SVG morphing and disables CSS motion; hidden routes also pause the animation. The decorative graphic is hidden from assistive technology, loading text uses a live status, and replaced results are inert while loading.

Verification:

- Existing responsive browser journey: 304 checks passed across 19 viewport sizes.
- Temporary browser visual harness: inspected desktop/mobile screenshots at 280, 390, 768 and 1440 px; animated morph, reduced motion, filter cancellation/stale completion, result reveal, pagination, errors, navigation and sign-out passed with no browser errors.
- Measured exit opacity at 120 ms was about 0.44, confirming a fade rather than abrupt removal. Initial route entrance commits resting styles without delaying discovery or results.
- Browser component build passed. TypeScript diagnostic counts remain at the existing 424-error baseline, with no new file/error-code counts.
- Screenshots and the disposable visual harness are under `.local/development-gui-evidence/discovery-loader/` and `.local/loader-preview.ts` (ignored local evidence).

No provider/model requests or protocol changes were needed. No new animation dependency or production test suite was introduced for this visual change.

The default development service was restarted after confirming zero active model actions. It is ready at http://127.0.0.1:49371, PID 37207, with the saved ChatGPT OAuth mode retained. A fresh browser smoke check confirms the shipped loader markup/styles and connected Explore route without browser errors.
