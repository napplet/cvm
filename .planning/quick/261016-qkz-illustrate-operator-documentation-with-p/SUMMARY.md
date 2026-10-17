---
status: complete
workflow: gsd-quick (inline)
date: 2026-10-16
---

# Illustrated operator documentation

Added eight screenshots across five operator pages: overview, local installation, accounts/providers, operations and security. Captures show operator access, subscription account/model selection, API-account entry, development rates, pending/active/finished job lists and job details. Installation and configuration commands remain copyable text.

The shared screenshot component now supports separate user and operator catalogs while preserving existing user-guide paths, dimensions, captions and full-size links. Operator captions identify sample admin data. The operations guide distinguishes saved pending work, active/unknown-outcome records, verified generation and actual publication confirmation.

`docs/scripts/capture-operator-screenshots.ts` serves actual admin HTML/CSS and bundled browser code with an offline read-only CVM transport. It uses a fictional account, empty credential fields, the real development-pricing helper, and job fields/billing entries matched to the SQL projection. External HTTP/WebSockets are blocked; configuration writes, authorization and inference are rejected. Recorded calls are checked as read-only and the disposable browser session is cleared through Lock admin. No live operator credential, OAuth session, CVM data or provider was accessed.

## Verification

- Eight native Chromium captures generated and visually reviewed; no retouched product controls or live credentials.
- VitePress production build passed: 38 HTML pages, including 404.
- Local link/asset/fragment check passed: 1,296 references under `/docs/`.
- Browser check passed: 90 page/viewport combinations (280–1280 px), 125 image decodes/dimension/alt checks, full-size image links for both audiences, search, mobile navigation/sidebar and direct reload.
- Desktop/mobile provider-guide renders reviewed in `.local/docs-evidence/`; no browser errors or parent horizontal overflow.
- `git diff --check` passed. Runtime code, dependency pins and the running CVM were not changed.

Preview: http://127.0.0.1:4173/docs/operators/providers

## Continuity

Documentation now has 20 screenshots: 12 for users and eight for operators, with repeatable capture for each. The publication-state tracking defect and publishing UI refresh remain pending application work. Production verification remains deferred.
