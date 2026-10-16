---
status: complete
task: 261015-pf8
date: 2026-10-15
commit: 6e88c24
---

# Paja previews start minimized

The preview host initializes Paja's native console preference to collapsed before the browser module starts. A load-time native-toggle fallback covers unavailable browser storage. The chevron remains available, and toggling preserves the iframe identity and napplet state.

The pinned Paja 0.19.0 server exposes no initial-console option. A separate loopback host wraps only its five existing GET routes and initializes presentation in the host HTML. The installed package, generated artifact, sandbox and simulation policy remain unchanged.

Verification: Chromium presentation check passed for initial collapse, native expand/collapse, retained target state, sandbox and unavailable storage. Full generation/preview boundary journey passed with the deterministic model fixture, real relay, payments, SQL, Docker worker and Paja; parent storage and direct network access remain blocked. No live model request was needed. Root dependency manifests are unchanged.
