---
phase: 06-sealed-preview-user-owned-publication
plan: "03"
subsystem: publication
tags: [nostr, nip-01, nip-5d, signing-handoff, attestation, sha256]
requires:
  - phase: 06-01
    provides: sealed verified-artifact publication contracts and persistence tracer
  - phase: 06-02
    provides: canonical capability-review approval digest
provides:
  - canonical expiry-aware publication intent and owner manifest template
  - independent NIP-01 completed-event verification with generic denial
  - separate ownership-neutral CVM build attestation
affects: [phase-06-plans-04-through-07, contextvm-publication-adapter, sealed-deployment]
tech-stack:
  added: [nostr-tools@2.24.1]
  patterns: [versioned-approval-bytes, pure-nip-01-verification, completed-public-event-only, command-identity-fencing]
key-files:
  created:
    - src/publication/publication-intent.ts
    - src/publication/manifest-event.ts
    - src/publication/attestation-event.ts
    - tests/phase-06/publication-intent.test.ts
    - tests/phase-06/manifest-signature.test.ts
    - tests/phase-06/nostr-tools-direct-dependency.test.ts
  modified:
    - src/publication/publication-service.ts
    - src/publication/contracts.ts
    - src/persistence/publication-store.ts
key-decisions:
  - "A SHA-256 fingerprint of versioned UTF-8 approval bytes determines the publication intent ID, while one persisted idempotency key closes changed-fence replays."
  - "Production code imports only serializeEvent, getEventHash, and verifyEvent from nostr-tools/pure; user signing remains entirely external."
  - "A signed ContextVM command must echo the persisted intent fingerprint and all stable effect operation identities before any publication effect."
patterns-established:
  - "Completed public events are independently parsed, serialized, hashed, signature-checked, and compared exactly to a persisted template; every failure returns INVALID_OWNER_MANIFEST."
  - "CVM attestations are distinct typed provenance records that cite, but never replace or claim, the owner event."
requirements-completed: [PREV-04, PUB-01, PUB-02, PUB-03]
coverage:
  - id: D1
    description: "Canonical publication intent binds all approval fences, expiry, runtime digest detail, exact replay, and conflicting reuse."
    requirement: PUB-01
    verification:
      - kind: unit
        ref: "tests/phase-06/publication-intent.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Pure NIP-01 verification accepts only an exact completed owner event and returns one generic denial for cryptographic, expiry, and semantic mismatches."
    requirement: PUB-02
    verification:
      - kind: unit
        ref: "tests/phase-06/manifest-signature.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "CVM attestation remains a distinct immutable provenance record with explicit evidence linkage and no owner claim."
    requirement: PUB-03
    verification:
      - kind: unit
        ref: "tests/phase-06/manifest-signature.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "The exact direct nostr-tools pin and pure verification exports resolve from the root lockfile."
    requirement: PUB-02
    verification:
      - kind: unit
        ref: "tests/phase-06/nostr-tools-direct-dependency.test.ts"
        status: pass
    human_judgment: false
metrics:
  duration: 9m 26s
  completed_date: 2026-08-05
status: complete
---

# Phase 06 Plan 03: User-Owned Manifest Verification Summary

Canonical publication intent fencing now yields one externally signed kind-35129 owner template, while only a cryptographically and semantically exact completed event can proceed toward publication.

## Performance

- **Duration:** 9m 26s
- **Started:** 2026-08-05T08:50:38Z
- **Completed:** 2026-08-05T09:00:04Z
- **Tasks:** 3/3
- **Files modified:** 11

## Accomplishments

- Created versioned UTF-8 publication-intent bytes, normalized named d-tags, exact expiry semantics, a deterministic owner template, and closed idempotency conflict handling.
- Declared `nostr-tools@2.24.1` as an exact direct root dependency and constrained production use to `nostr-tools/pure` serialization, hash, and signature verification exports.
- Added generic public owner-event denial, signed command/operation-identity fencing, and a separate deterministic CVM attestation record that does not claim ownership.

## Task Commits

1. **Task 1: Persist one canonical expiring publication intent and owner template** — `6f8df99` (RED), `ee5257a` (GREEN)
2. **Task 2: Declare the exact direct NIP-01 verification dependency** — `d8e7504`
3. **Task 3: Verify the completed owner event and construct a distinct attestation** — `2fa819e` (RED), `08a8d70` (GREEN)

## Verification

- `bun test tests/phase-06/nostr-tools-direct-dependency.test.ts tests/phase-06/publication-intent.test.ts tests/phase-06/manifest-signature.test.ts tests/phase-06/tracer.test.ts --timeout 10000` — 13 passed, 0 failed.
- Production source audit found the sole Nostr import at `src/publication/manifest-event.ts`, importing only `getEventHash`, `serializeEvent`, and `verifyEvent` from `nostr-tools/pure`.

## Decisions Made

- Publication intent IDs are derived from the full canonical approval fingerprint; runtime compatibility remains bound through the already-approved capability digest rather than a fallback identity.
- Template comparison includes every tag and exact content after independent NIP-01 serialization and signature verification, so a valid signature cannot authorize changed semantics.
- The command identity is compared with the durable intent fingerprint and all three deterministic child-operation IDs before external effects can begin.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Extended the existing contracts and in-memory store for complete identity fencing**
- **Found during:** Task 1
- **Issue:** The Phase 6 tracer contracts lacked fields for artifact/manifest/d-tag/policy fences and its store keyed only by intent ID, allowing changed-fence use of an existing idempotency key to evade a closed conflict.
- **Fix:** Added explicit immutable approval and signed-command fields, plus an idempotency-key index that only returns an exact stored fingerprint.
- **Files modified:** `src/publication/contracts.ts`, `src/persistence/publication-store.ts`, `src/publication/publication-service.ts`
- **Verification:** Publication-intent and tracer tests pass.
- **Committed in:** `ee5257a`

**Total deviations:** 1 auto-fixed (1 Rule 2).
**Impact on plan:** The additions are required for the plan's exact replay, semantic-binding, and no-effect-before-command guarantees; no unrelated scope was added.

## Known Stubs

None. Deterministic test-only signer fixtures are confined to tests; production accepts completed public events only.

## Next Phase Readiness

Plan 06-04 can persist the resulting intent/template, signed command identity, and child operation records in its durable publication state machine. No external setup is required.

## Self-Check

PASSED — all six created artifacts and all five task/TDD commits exist in git history.
