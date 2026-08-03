# Phase 1 API Coverage Determination

No external API integration: Phase 1 runs pinned local napplet binaries and local Chromium; it adds no remote client, endpoint, webhook, callback, or wire protocol.

Candidate intake may read public package and source metadata to assemble provenance evidence. That is a promotion-time supply-chain check, not a product API integration; it is constrained to reviewed origins, captured as immutable evidence, and never occurs during the sealed verification run. Consequently an endpoint/authentication/error-mapping matrix would fabricate an interface that is not in this phase.

The phase also adds no database schema or persistence service. Promotion state, evidence, reviewed goldens, and the current toolchain pointer are repository-local immutable or append-only artifacts.
