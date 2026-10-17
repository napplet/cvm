---
status: complete
workflow: gsd-quick (inline)
date: 2026-10-16
---

# Illustrated user documentation

Added 12 native Chromium screenshots to eight user-guide pages: overview, first applet, create/revise, identity/projects, remix/explore, publication, costs and troubleshooting. Screenshots appear beside their corresponding instructions with alternative text, task-specific captions and full-size links. Layout dimensions are recorded to reserve image space; images scale down without enlarging small crops.

`docs/scripts/capture-user-screenshots.ts` renders the actual current workspace classes and stylesheet in an isolated browser with disposable sample identities and data. Service stages and responses are simulated and the iframe contains a sample counter; the docs identify these as illustrations, not end-to-end evidence. The harness blocks external HTTP/WebSocket connections and rejects real generation, signing and publication. The identity crop excludes the pairing QR. No live CVM, user project, account, credential, or subscription was used. Publication screenshots stop at review and do not imply the pending publication-state defect is fixed.

Maintainers can regenerate all PNGs and their dimensions with the documented command. The browser checker now covers all eight illustrated guides in addition to the prior operator/implementer/developer checks.

## Verification

- Screenshot capture: 12 images, visually reviewed; tall panels captured with enough viewport space to avoid the fixed application footer.
- VitePress production build: passed, 38 HTML pages including the 404 page.
- Local href/src/fragment audit: 1,258 links/assets/fragments passed under `/docs/`.
- Browser checks: 70 page/viewport combinations (280, 320, 390, 768, 1280 pixels), 75 image loads with intrinsic-size and alt-text checks, full-size image link, search, mobile navigation/sidebar and deep reload passed.
- User-guide desktop/mobile renders inspected; no parent horizontal overflow or browser errors. Evidence: `.local/docs-evidence/`.
- Root runtime dependencies, launcher hashes and application behavior unchanged. No service test or provider request was necessary for this documentation-only work.

Preview: http://127.0.0.1:4173/docs/users/quick-start

## Continuity

User docs now have screenshot coverage. The reported successful-publication tracking defect and publishing UI design update remain the next application task; no attempt to fix or disguise them was made here. Production verification remains deferred. The user's CVM on port 49371 was not restarted or mutated.
