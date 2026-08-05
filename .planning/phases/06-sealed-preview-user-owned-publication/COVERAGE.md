# Phase 6 API and Source Coverage

This is the canonical Phase 6 coverage artifact. `INTEGRATE` means the capability is exercised through a project-owned port, adapter, service, test, or evidence probe. `OPT-OUT` means it is deliberately unreachable for the stated reason. Live host, signer, standalone CLI asset, relay, Blossom, PostgreSQL/Cockroach, and provider certification remain `not_observed` evidence owned by Phase 7; deterministic ports and fakes are the Phase 6 authority.

## Canonical capability matrix

| capability | decision | reason |
|---|---|---|
| PKG-01 npm @napplet/cli 0.0.0 | OPT-OUT | Wrong registry identity; the exact-source probe and adapter make it unreachable. 06-05-01, 06-05-02, 06-07-02. |
| PKG-02 promoted standalone napplet CLI 0.5.2 | INTEGRATE | Exact commit `1a38b9150f3a3da148091c11bce4d0365f7298e5` / Linux SHA-256 `46685f2e4df516b5b2e7e2e133480c90e5c85dbd36d05c6e95f4eee6af33ec5e`; source probe/facade, no install. 06-05-01, 06-05-02. |
| PKG-03 direct nostr-tools 2.24.1 pure API | INTEGRATE | Declare exact direct dependency, verify root manifest/lock resolution, and use only `nostr-tools/pure` verification exports. 06-03-02, 06-03-03. |
| HOST-01 host runtime operation descriptor | INTEGRATE | Bind exact artifact, entrypoint, manifest, runtime variant, capability digest, operation, and expiry. 06-01-01, 06-02-01. |
| HOST-02 sandboxed iframe runtime | INTEGRATE | Allow scripts only; deny same-origin and authority-bearing messages. 06-02-01. |
| HOST-03 short-lived exact-artifact grant | INTEGRATE | Permit one sealed read and no signer, relay, storage, network, or publication authority. 06-02-01. |
| HOST-04 required/optional NAP capability negotiation | INTEGRATE | Required absence blocks; optional absence degrades; canonical review feeds one digest. 06-02-02. |
| HOST-05 direct browser authority | OPT-OUT | Generated code never receives fetch, storage, cookies, signer, relay, or window.nostr authority. 06-02-02, 06-06-02. |
| NIP5D-01 named manifest kind 35129 and normalized d-tag | INTEGRATE | One owner template binds one approved named napplet. 06-03-01, 06-03-02. |
| NIP5D-02 root manifest kind 15129 | OPT-OUT | Root-site replacement is outside the one named d-tag intent and is rejected by probe/adapter. 06-05-01, 06-05-02. |
| NIP5D-03 snapshot kind 5129 and companion event | OPT-OUT | A second owner event violates the one-intent/one-owner-event boundary and is rejected by probe/adapter. 06-05-01, 06-05-02. |
| NIP5D-04 exact manifest file entries and hashes | INTEGRATE | Paths, MIME, sizes, hashes, entrypoint, and aggregate must match sealed bytes. 06-03-03, 06-05-02. |
| NIP5D-05 requires and archetype sidecar fields | INTEGRATE | Preserve verified manifest fields and derive capability review; never invent them. 06-02-02, 06-05-02. |
| NIP5A-01 deterministic aggregate manifest hash | INTEGRATE | Recompute over exact verified file hashes before preview, signing, and deploy. 06-02-01, 06-03-03, 06-05-02. |
| NIP01-01 canonical event serialization and id | INTEGRATE | Serialize completed event and require declared id to equal independent hash. 06-03-03. |
| NIP01-02 Schnorr signature verification | INTEGRATE | Verify cryptographically; expose one generic invalid-manifest result. 06-03-03. |
| NIP01-03 semantic event binding | INTEGRATE | Verify owner, kind, tags, content, d-tag, artifact, capability, intent, and expiry. 06-03-03. |
| ATTEST-01 CVM build attestation | INTEGRATE | Distinct immutable service attestation cites evidence without claiming ownership. 06-03-03, 06-05-03. |
| CLI-01 create/init scaffolding | OPT-OUT | Generation owns scaffold creation; source probe forbids command/scaffold entrypoints. 06-05-01. |
| CLI-02 skills management | OPT-OUT | Skill install/update/remove/list/status has no publication authority. 06-05-01. |
| CLI-03 discover/debug/Paja surfaces | OPT-OUT | Workspace inspection/mutation is outside sealed publication. 06-05-01, 06-05-02. |
| CLI-04 conformance commands | OPT-OUT | Publication verifies upstream conformance evidence and does not rerun the build. 06-05-01. |
| CLI-05 secret/keychain signing modes | OPT-OUT | CVM never receives, stores, logs, or requests a user private key. 06-03-03, 06-05-01, 06-05-02. |
| CLI-06 bunker/NIP-46 signer configuration | OPT-OUT | User signs in the external host; CVM receives a completed public event only. 06-03-03, 06-05-01, 06-05-02. |
| CLI-07 project discovery and monorepo all selection | OPT-OUT | Rediscovery can substitute bytes or add targets after approval; the route accepts direct sealed payload records only. 06-05-01, 06-05-02. |
| CLI-08 dependency/build/prebuilt/rebuild paths | OPT-OUT | Publication cannot change dependencies, build output, or manifest content. 06-05-01, 06-05-02. |
| CLI-09 d-tag normalization and validation | INTEGRATE | One normalized value round-trips intent, event, named target, and result. 06-03-01, 06-05-01, 06-05-02. |
| CLI-10 named-target pre-signed deployment | INTEGRATE | Consume one completed kind-35129 event; reject root, snapshot, or multiple targets without calling deploy planning. 06-05-01, 06-05-02. |
| CLI-11 exact structured deploy payloads | INTEGRATE | Build typed payload records from the sealed artifact and reject the source workspace collector. 06-05-01, 06-05-02. |
| CLI-12 Blossom server selection | INTEGRATE | Accept an allowlisted server set; record live selection/certification not_observed. 06-05-01, 06-05-02, 06-07-02. |
| CLI-13 relay selection | INTEGRATE | Accept an allowlisted relay set; record live selection/certification not_observed. 06-05-01, 06-05-02, 06-07-02. |
| CLI-14 Blossom upload authorization | INTEGRATE | Server-owned signer authorizes exact hashes only and cannot create owner events. 06-05-01, 06-05-02. |
| CLI-15 multi-server file upload | INTEGRATE | Use structured upload arguments/results; require one server to contain every file. 06-05-01, 06-05-02, 06-05-03. |
| CLI-16 full-server upload gate | INTEGRATE | Relay publication begins only after one server confirms the full sealed set. 06-05-01, 06-05-02. |
| CLI-17 pre-signed event relay publication | INTEGRATE | Relay the exact user event without re-signing or semantic mutation. 06-05-01, 06-05-02, 06-05-03. |
| CLI-18 structured progress and result contracts | INTEGRATE | Consume typed source progress/upload/relay/network results only. 06-05-01, 06-05-02. |
| CLI-19 network success predicate | INTEGRATE | Complete requires one full server and every linked event on at least one relay. 06-05-01, 06-05-03. |
| CLI-20 failure/timeout/partial summaries | INTEGRATE | Persist safe structured observations; unknown reconciles through original operation lookup only. 06-05-03. |
| CLI-21 monolithic executeNetworkDeploy orchestration | OPT-OUT | It combines upload and relay effects and requires a signer; Phase 6 uses only separately claimed lower-level calls. 06-05-01, 06-05-03. |
| CLI-22 command dry-run/JSON/human-stdout path | OPT-OUT | The command path performs discovery/planning/signing and prints reports; publication consumes structured source arguments/results and never parses human output. 06-05-01, 06-05-02. |
| CTX-01 signed preview tool | INTEGRATE | Descriptor and capability-review actions run for the verified owner. 06-06-01. |
| CTX-02 signed publication tool | INTEGRATE | Create-intent, submit-event, status, and reconcile actions use strict schemas. 06-06-01. |
| CTX-03 safe notifications and next actions | INTEGRATE | Allowlisted facts and exactly five owner-safe next actions. 06-06-01, 06-06-02. |
| EFFECT-01 persist-before-effect child intents | INTEGRATE | Deploy, owner-manifest, and attestation operations are durable before I/O. 06-04-01, 06-04-02, 06-05-03. |
| EFFECT-02 original-operation observation | INTEGRATE | Unknown reconciliation performs lookup only and creates no effect. 06-05-03. |
| EFFECT-03 linked terminal publication result | INTEGRATE | Complete links owner event, attestation, artifact, upload, and relay evidence. 06-05-03, 06-06-02. |

## Promoted identity detail

- PKG-02 complete identity: standalone napplet CLI 0.5.2, commit `1a38b9150f3a3da148091c11bce4d0365f7298e5`, Linux SHA-256 `46685f2e4df516b5b2e7e2e133480c90e5c85dbd36d05c6e95f4eee6af33ec5e`.
- PKG-01 complete identity: npm `@napplet/cli@0.0.0`; it is the wrong implementation and must never be installed.
- PKG-03 complete identity: exact direct `nostr-tools@2.24.1`; Plan 06-03 updates `package.json` and `bun.lock` and verifies only the `nostr-tools/pure` serialization/hash/signature surface.

## Edge-probe matrix

All probes use exact strings, bytes, integer timestamps, canonical serialization, and cryptographic hashes. No rounding or tolerance is introduced.

1. E-01 — Empty artifact is denied before descriptor creation. 06-02-01, 06-07-01.
2. E-02 — Null artifact is denied before descriptor creation. 06-02-01, 06-07-01.
3. E-03 — Empty manifest is denied before preview or intent. 06-02-01, 06-07-01.
4. E-04 — Null manifest is denied before preview or intent. 06-02-01, 06-07-01.
5. E-05 — Empty capability set round-trips as one canonical empty review/digest. 06-02-02, 06-07-01.
6. E-06 — Null capability set is invalid rather than silently empty. 06-02-02, 06-07-01.
7. E-07 — Permuted capability input yields stable required-first ordering. 06-02-02, 06-07-01.
8. E-08 — Equivalent reviews have equal canonical bytes/digest; any field change differs. 06-02-02, 06-07-01.
9. E-09 — One millisecond before intent expiry remains eligible. 06-03-01, 06-07-01.
10. E-10 — The exact expiry instant is denied. 06-03-01, 06-07-01.
11. E-11 — One millisecond after expiry is denied. 06-03-01, 06-07-01.
12. E-12 — Exact replay returns the stored intent/result without a new effect. 06-03-01, 06-04-01, 06-07-01.
13. E-13 — Same key with a different fingerprint is a closed conflict. 06-03-01, 06-04-01, 06-07-01.
14. E-14 — Concurrent submitters yield one claimant and one stored replay. 06-04-01, 06-04-02, 06-07-01.
15. E-15 — Interrupted dispatch records unknown/pending rather than terminal. 06-05-03, 06-07-01.
16. E-16 — Reconciliation observes only original operation ids and creates no effect. 06-05-03, 06-07-01.
17. E-17 — Valid signature with wrong artifact binding is generically denied. 06-03-02, 06-07-01.
18. E-18 — Valid signature with wrong d-tag is generically denied. 06-03-02, 06-07-01.
19. E-19 — Valid signature with wrong capability/intent/expiry binding is generically denied. 06-03-02, 06-07-01.
20. E-20 — CLI source failure persists safe failed observation and recovery action. 06-05-03, 06-07-01.
21. E-21 — CLI source timeout persists unknown and enables lookup-only reconciliation. 06-05-03, 06-07-01.
22. E-22 — CLI source partial upload/publish remains partial. 06-05-03, 06-07-01.
23. E-23 — All runtime variants round-trip identical artifact, intent, and capability-digest fences. 06-03-01, 06-07-01.

## Multi-source coverage audit

### GOAL

- COVERED — Inspect, preview, explicitly publish one immutable verified napplet, with sole user key/signature custody. Plans 06-01 through 06-07.
- COVERED — Preview uses the exact verified artifact through a sandboxed host contract. Plans 06-01, 06-02, 06-06.
- COVERED — Publication uses exact sealed bytes, one user-signed owner event, and a distinct CVM attestation. Plans 06-03, 06-05.
- COVERED — Replay, partial effect, and ambiguous outcome handling is safe and recoverable. Plans 06-04, 06-05, 06-06.

### REQ

- COVERED — PREV-01: 06-01, 06-02, 06-06, 06-07.
- COVERED — PREV-02: 06-01, 06-02, 06-06, 06-07.
- COVERED — PREV-03: 06-01, 06-02, 06-06, 06-07.
- COVERED — PREV-04: 06-01, 06-02, 06-03, 06-06, 06-07.
- COVERED — PUB-01: 06-01, 06-03, 06-04, 06-06, 06-07.
- COVERED — PUB-02: 06-01, 06-03, 06-06, 06-07.
- COVERED — PUB-03: 06-01, 06-03, 06-06, 06-07.
- COVERED — PUB-04: 06-01, 06-05, 06-06, 06-07.
- COVERED — PUB-05: 06-01, 06-04, 06-05, 06-06, 06-07.

### CONTEXT

- COVERED — D-96, D-97, D-98, D-99, D-100, D-101: 06-02 must-haves.
- COVERED — D-102: 06-02 and 06-03 must-haves.
- COVERED — D-103, D-104, D-105, D-106: 06-03 must-haves.
- COVERED — D-107: 06-03 and 06-04 must-haves.
- COVERED — D-108: 06-05 must-haves.
- COVERED — D-109: 06-04 and 06-05 must-haves.
- COVERED — D-110: 06-05 must-haves.
- COVERED — D-111, D-112, D-113: 06-06 must-haves.

Deferred Context ideas are excluded: live host/signer/relay/Blossom/provider selection and certification, multi-region rollout/chaos, exhaustive supply-chain certification, x402/L402 adapters, automatic publication, and user-key custody.

### RESEARCH

- COVERED — Narrow deterministic host/signer ports and live-certification honesty: 06-01, 06-02, 06-03, 06-07.
- COVERED — Stable capability canonicalization/digest and runtime compatibility binding: 06-02, 06-03.
- COVERED — Independent NIP-01 and semantic event verification with generic failure: 06-03.
- COVERED — Persist-before-effect child intents and original-operation observation: 06-04, 06-05.
- COVERED — Exact direct `nostr-tools@2.24.1` pin and pure verification API: canonical matrix, 06-03, 06-07.
- COVERED — Promoted standalone CLI identity, exact-source pre-signed-route probe, fail-closed publication availability, and invalid npm package exclusion: canonical matrix, 06-05, 06-06, 06-07.
- COVERED — Exact sealed bytes across plan/upload/event/attestation without rebuild: 06-03, 06-05.
- COVERED — Actual-authority evidence plus provider `not_observed` records: 06-07.
- COVERED — No durable admission queue and no preview/top-up publication effect: 06-01, 06-05, 06-06.

### UI

- COVERED — Empty/pre-preview and absent-manifest states explicit and blocking: 06-06 must-haves.
- COVERED — Loading preserves identity, concise progress, and disabled unsafe duplicate: 06-06 must-haves.
- COVERED — Error exposes safe recovery without raw internals: 06-06 must-haves.
- COVERED — Populated flow is linear with exact owner-safe facts: 06-06 must-haves.
- COVERED — Partial distinguishes optional degradation and external effects: 06-06 must-haves.
- COVERED — Sole inspector scroll plus stacked mobile/no nested horizontal panes: 06-06 must-haves.
- COVERED — Zero/one/many capability behavior required-first with labelled evidence: 06-06 must-haves.
- COVERED — Wrapped descriptions and middle-ellipsized labelled/copyable accessible identifiers: 06-06 must-haves.
- EXPLICIT — `06-UI-SPEC.md` supplies zero backstop and zero unresolved rows; no extra behavior is inferred.

## Source-audit verdict

All GOAL, REQ, RESEARCH, CONTEXT, and UI items are covered. No item is missing, no developer-confirmed deferral is required, and no phase split is requested.
