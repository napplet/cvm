---
phase: 06-sealed-preview-user-owned-publication
verified: 2026-08-05T11:19:44Z
status: passed
score: "5/5 must-haves verified"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: "4/5"
  gaps_closed:
    - "PREV-04 / D-101: incompatible required capabilities are denied before any host descriptor exists."
  gaps_remaining: []
  regressions: []
deferred:
  - truth: "Live compatible-host, external-signer, promoted CLI asset, relay, Blossom, PostgreSQL/Cockroach, and selected-provider certification."
    addressed_in: "Phase 7"
    evidence: "Phase 6 design evidence records each as not_observed with owner Phase 7 and PHASE_07_LIVE_CERTIFICATION_REQUIRED."
---

# Phase 6: Sealed Preview & User-Owned Publication Verification Report

**Phase Goal:** A user can inspect, preview, and explicitly publish one immutable verified napplet while retaining sole control of their private key and manifest signature.

**Verified:** 2026-08-05T11:19:44Z  
**Status:** passed  
**Re-verification:** Yes — after PREV-04 gap closure and final source-provenance/security audit

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | A user can preview only the exact immutable aggregate-hash artifact that passed validation in an `allow-scripts`-only NIP-5D shell. | ✓ VERIFIED | `PreviewService` reads and checks the verified artifact/review and creates only an `allow-scripts` / `preview_read_only` descriptor. Descriptor, runtime-status, and tracer tests pass. |
| 2 | A user can inspect capability consent/compatibility; unsupported required capabilities block preview and optional ones degrade without direct authority. | ✓ VERIFIED | `37ce3ac` denies `review.compatibility === "incompatible"` before `PreviewHostPort.createDescriptor`. Direct exercise: denied, zero host calls/descriptors; optional absence remains `degraded` and produces one descriptor. |
| 3 | Explicit publication intent binds account, session, d-tag, capability set, and exact artifact; only an external/host signer supplies the completed owner event. | ✓ VERIFIED | Intent recomputes canonical approval from the sealed artifact; NIP-01 verification accepts only the completed public event. No user-secret schema or port exists. |
| 4 | CVM verifies the owner event, makes a separate evidence-bound attestation, and deploys sealed bytes only through the promoted CLI source contract. | ✓ VERIFIED (deterministic boundary) | `c71ee63` binds exact identity, Linux source files/hashes, and complete safe surface through source validation, announcement, funded composition, ContextVM construction/dispatch, and CLI adapter. The source probe remains fail-closed and does not claim live execution. |
| 5 | Duplicate/timed-out publication reconciles persisted original operations without rebuilding, re-signing, double-deploying, or conflicting ownership. | ✓ VERIFIED | Durable claims and original-operation observation are exercised through replay, concurrency, partial, unknown, SQLite, and PostgreSQL-shaped store tests. |

**Score:** 5/5 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/publication/contracts.ts` | Strict artifact, capability, event, intent, and port boundaries | ✓ VERIFIED | Substantive schemas exclude user private keys and carry sealed file/effect facts. |
| `src/publication/preview-service.ts` | Exact read-only preview gate | ✓ VERIFIED | Rejects an incompatible required-capability review before host invocation. |
| `src/publication/capability-review.ts` | Canonical required/optional review and digest | ✓ VERIFIED | Required absence is `incompatible`; optional absence is `degraded`; canonicalization tests pass. |
| `src/publication/publication-service.ts` and durable stores | Intent, verification, single-claim effects, replay/reconciliation | ✓ VERIFIED | Wired to memory/SQLite/PostgreSQL-shaped stores; focused parity and service tests pass. |
| `src/publication/manifest-event.ts` and `attestation-event.ts` | User event verification and separate CVM attestation | ✓ VERIFIED | `nostr-tools/pure` verification, generic invalid result, and attestation separation tests pass. |
| `src/publication/napplet-cli-source-contract.ts` | Exact promoted CLI provenance validator | ✓ VERIFIED | Rejects changed commit identity, source hash, structured surface, and unsafe route; validated object retains complete provenance across trust boundaries. |
| `src/publication/napplet-cli-adapter.ts` | Sealed-byte source-contract facade | ✓ VERIFIED | Revalidates construction-time and dispatch-time source contract; unavailable, forged, or mutated contract reaches no source effect. |
| `src/phase-03/funded-core.ts`, `src/contextvm/announcement.ts`, and `src/contextvm/adapter.ts` | Truthful public availability and signed dispatch | ✓ VERIFIED | Publication is announced/constructed/dispatched only with a currently exact validated source contract; tests prove forged or mutated `available` contracts fail before facade effects. |
| `evidence/design/phase-06.json` | Content-addressed design evidence | ✓ VERIFIED | Repeated Phase 6 evidence verification succeeds and retains external observations as `not_observed`. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- |
| verified artifact | preview descriptor | `SealedArtifactPort` → `PreviewService` → `PreviewHostPort` | WIRED | Identity reaches the descriptor only when review compatibility is not `incompatible`; regression proves no host call on required-capability absence. |
| verified manifest | review → intent → owner event | canonical review/digest and intent template | WIRED | Canonical review, exact intent fencing, and semantic NIP-01 validation are exercised by focused tests. |
| publication service | durable claims → deploy/owner relay/attestation → status | stable original operation identities | WIRED | Persist-before-effect and original-operation reconciliation are covered by replay, timeout, partial, and concurrency tests. |
| exact source probe evidence | funded composition → announcement → ContextVM construction/dispatch → CLI adapter | `validatedAvailablePromotedCliSourceContract` | WIRED | `c71ee63` requires exact identity, all source hashes, required exports, and rejected routes at each authority boundary; a structural/forged/mutated available value neither advertises publication nor reaches the facade. |
| ContextVM signed caller | preview/publication facade | verified pubkey → account ID → strict action schema | WIRED | Signed-preview denial has no descriptor; publication remains fail-closed without valid exact source provenance. |

### Data-Flow Trace

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| Preview descriptor | verified `artifact`, canonical `review` | `SealedArtifactPort.readVerified` → `canonicalCapabilityReview` | Required absence returns safe denial; optional absence flows as `degraded` | ✓ FLOWING |
| Publication result | persisted intent, public event, effect observations | `DurablePublicationStore` and bounded effect ports | Deterministic service/store transitions | ✓ FLOWING |
| Source availability | exact identity, source files/hashes, safe CLI surface | source probe → strict validator → core/announcement/adapter | Only complete, current provenance can expose or dispatch publication | ✓ FLOWING |
| Design evidence | post-assertion case observations | named Phase 6 reference cases | Stable content-addressed record; repeated verification passes | ✓ FLOWING |

### Prohibition Checks

| Prohibition | Status | Evidence |
| --- | --- | --- |
| Never preview unverified/substituted bytes or missing required capabilities. | ✓ VERIFIED | Invalid inputs deny before host calls; exact sealed deployment rejects substituted files; required absence denies before descriptor creation. |
| Never grant same-origin/direct runtime authority. | ✓ VERIFIED | Descriptor permits only `allow-scripts` and `preview_read_only`; authority-expansion test passes. |
| Never receive, request, persist, or log a user private key. | ✓ VERIFIED | Owner-event schemas contain public NIP-01 fields only; signing remains host/external-signer work. |
| Never expose publication based on a structural or stale source-availability value. | ✓ VERIFIED | Complete provenance is revalidated at announcement, construction, and dispatch; forged/mutated values produce `publication_unavailable` before facade/source effects. |
| Never rebuild, re-sign, redeploy, or create a second effect while reconciling. | ✓ VERIFIED | Stable claims plus original-operation observation pass replay, timeout, and concurrency tests. |
| Never report partial publication as complete. | ✓ VERIFIED | Completion predicate requires all persisted deploy/relay/attestation evidence. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| PREV-04 denial plus optional degradation | direct `bun -e` invocation of `PreviewService` | Required absence: denied, `hostCalls=0`, `descriptorCount=0`; optional absence: `degraded`, `hostCalls=1` | ✓ PASS |
| Phase 6 focused service/adapter gates | `bun test tests/phase-06 tests/contextvm/publication-adapter.test.ts tests/contextvm/adapter.test.ts tests/contextvm/announcement.test.ts --timeout 10000` | 62 pass, 0 fail | ✓ PASS |
| Exact provenance boundary | `bun test tests/phase-06/cli-source-contract.test.ts tests/phase-06/sealed-deployment.test.ts tests/contextvm/publication-adapter.test.ts tests/funding/funded-admission.test.ts --timeout 10000` | 27 pass, 0 fail | ✓ PASS |
| Source probe | `bun run probe:phase06-cli-source` | `publication_unavailable`, `SOURCE_CHECKOUT_NOT_PROVIDED`, `liveExecution: not_observed` | ✓ PASS — fail closed |
| Reference authority matrix | `bun run eval:phase06` | 3 pass, 0 fail | ✓ PASS |
| Deterministic evidence | `bun run verify:phase06-design` twice | Both runs completed successfully | ✓ PASS |
| Full workspace regression | `bun test --timeout 10000` | 424 pass, 0 fail, 2,095 expectations across 69 files | ✓ PASS |

### Requirements Coverage

| Requirement | Status | Evidence |
| --- | --- | --- |
| PREV-01 | ✓ SATISFIED | Exact sealed artifact identity and restricted descriptor are covered by descriptor/tracer tests. |
| PREV-02 | ✓ SATISFIED (deterministic boundary) | Descriptor fixes `allow-scripts` and rejects direct authority; live host certification is Phase 7. |
| PREV-03 | ✓ SATISFIED | Required/optional purpose, consent, availability, ordering, compatibility, and digest tests pass. |
| PREV-04 | ✓ SATISFIED | Required absence blocks the actual preview entrypoint and signed ContextVM action; optional absence remains explicit degradation. |
| PUB-01 | ✓ SATISFIED | Intent recomputes all fences and uses durable idempotency. |
| PUB-02 | ✓ SATISFIED | Completed public event only; no private-key surface. |
| PUB-03 | ✓ SATISFIED | Independent user-event verification and distinct evidence-bound attestation. |
| PUB-04 | ✓ SATISFIED (deterministic boundary) | Sealed bytes and exact promoted source contract are enforced throughout availability and dispatch; live CLI asset remains unavailable/not observed. |
| PUB-05 | ✓ SATISFIED | Persisted original-operation-only reconciliation prevents duplicate effects. |

### Nyquist, Security, and UI Audit Status

| Audit | Status | Evidence |
| --- | --- | --- |
| Nyquist validation | ✓ COMPLETE | `06-VALIDATION.md` records every named deterministic surface and requirement row green; all 15 draft Wave 0 file-exists rows were resolved with 0 escalations. Phase 7 live certification remains `not_observed`, not a coverage gap. |
| Security audit | ✓ VERIFIED | `06-SECURITY.md` records 51/51 threats closed and 0 blocking open. The `c71ee63` provenance hardening closes structural availability/dispatch trust-boundary exposure; its 27 focused regressions and the 424-test workspace gate pass. |
| UI audit | ℹ ADVISORY DEFERRED | `06-UI-REVIEW.md` scores 10/24 for the host-native contract projection and identifies 10 Phase 7 live-host presentation/copy/accessibility/responsive deferrals. No browser DOM was introduced in Phase 6, so these are not evidence against the sealed preview/publication goal. |

### Anti-Patterns Found

No blocker debt markers, placeholders, or stub implementations were found in the Phase 6 source-contract, composition, adapter, preview, or regression files inspected. The source probe's unavailable response is an intentional fail-closed live-certification boundary, not a placeholder implementation.

### Deferred Items

Live compatible-host, external-signer, promoted CLI asset, relay, Blossom, PostgreSQL/Cockroach, and selected-provider certification remain `not_observed`, explicitly owned by Phase 7. The Phase 7 UI work also owns the 10 advisory live-host presentation/accessibility/responsive findings. This Phase 6 verdict does not claim live publication availability without a verified source checkout and later live certification.

### Milestone Roll-up

- Milestone: v1.0 napplet-cvm.
- Completed/verified phases: 1–6; Phase 7 remains.
- Plans: 40 known and executed; Phase 6 executed 7/7 plans and passes final goal verification.
- Requirements: 49/54 verified through Phase 6 (PREV-01–04 and PUB-01–05 complete); 5 Phase 7 operational requirements remain.
- Next checkpoint: Phase 7 admission SLO, resilience, live certification, and launch-safety work.

---

_Verified: 2026-08-05T11:19:44Z_  
_Verifier: the agent (gsd-verifier)_
