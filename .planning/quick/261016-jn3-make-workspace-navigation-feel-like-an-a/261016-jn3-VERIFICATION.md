# Verification — 2026-10-16

| Check | Result |
| --- | --- |
| Primary vs. account/settings navigation, contextual Create/Builder, sticky header | Passed `product-view.e2e.ts` |
| Inline revision reasons, safe read-only action, blocked draft and resolved Send | Passed `product-view.e2e.ts` and `product-workspace.e2e.ts` |
| Collection navigation during generation, Working indicator and return to builder | Passed `returning-projects.e2e.ts` |
| Signed ownership, saved projects across browser/service restart | Passed `returning-projects.e2e.ts` |
| Contextual Publish, static cross-origin client, private admin and signed publication | Passed `static-cvm-publication.e2e.ts` |
| Desktop/phone layout and touch targets | Passed at 390, 768 and 1440 widths; inspected screenshots |
| Static build | `bun scripts/build-workspace.ts` passed |
| Whitespace check | `git diff --check` passed |
| TypeScript baseline comparison | 424 existing diagnostics before/after; no added file/message signatures |
| Live default service | Ready at port 49371 after zero-active-action check; navigation/back/forward/draft/mobile smoke passed |
| Dependency pins | package.json and bun.lock SHA-256 unchanged |

Logs retained locally: `/tmp/cvm-app-nav-view-final.log`, `/tmp/cvm-app-nav-product-final.log`, `/tmp/cvm-app-nav-projects.log`, `/tmp/cvm-app-nav-publication.log`, `/tmp/cvm-app-nav-typecheck-final.log`. Screenshots: `/tmp/cvm-live-app-nav-desktop.png`, `/tmp/cvm-live-app-nav-mobile.png`, and `.local/development-gui-evidence/applet-revision-blocked-{1440,390}.png`.

The deliberate invalid-TypeScript revision emits `WORKER_COMMAND_FAILED:verify` as expected while its browser suite passes. No live provider usage, historical unknown-operation reconciliation, dependency upgrade or production deployment was part of this change.
