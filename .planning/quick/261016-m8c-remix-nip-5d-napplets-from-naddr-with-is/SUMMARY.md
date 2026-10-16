---
status: complete
commit: fe48e1e
---

# Remix and public outbox discovery

Implemented homepage Remix with immediate naddr validation, signed-manifest and asset-hash checks, and a dedicated Explore page for the selected identity and its direct follows. Applesauce address/timeline loaders, EventStore and relay pool use NIP-65 outboxes discovered through purplepag.es. Existing workspace, preview and active request remain mounted across navigation.

CVM imports are signed, encrypted, owner-scoped and immutable. Small HTML crosses the protocol in bounded parts; the CVM verifies it again. Public GitHub source snapshots are pinned to a commit and parsed in the offline, read-only, constrained Docker worker. No repository code, dependency installation, hooks, symlinks or arbitrary host checkout. Unsupported source falls back to verified HTML. Imported context is untrusted model data, with its reference bound into command/checkpoint/provider fingerprints; revisions return to the generated version’s verified source. Provider credentials remain private to admin.

Limits are explicit in the runbook: 2 MB browser asset verification; 128 KB HTML fallback; 10 MB archive download; 8 source files / 96 KB; direct network capped at 100 followed authors and 12 relay connections. GitHub-only source retrieval is the initial supported policy. Current NIP-5D and the pinned CLI’s legacy index-path manifests are accepted without changing publication tooling.

Verification: signed relay/outbox unit tests; real SQL and offline Docker import boundary tests; browser through encrypted CVM, fixture inference, real Docker build and Paja preview, followed by revision (exactly two model fixture requests); pending-command fingerprint and resume tests; configured-provider regression; 304 responsive checks over 19 viewports; product view regression. Typecheck remains the existing 424 diagnostics with no new file/code diagnostics. No paid inference.

Live at http://127.0.0.1:49371, PID 40521, chatgpt-oauth retained, same worker image. Restart occurred with zero active actions. Added migration 012 and updated the launcher’s explicit root dependency pins for applesauce. Four historical saved actions already used an obsolete worker image; retained unchanged with strict pin checks. Live 320px smoke checked Remix/Explore/connection without generation. Unrelated research cache, design evidence, Playwright data and deno.lock remain untouched.
