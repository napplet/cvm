---
phase: 6
slug: sealed-preview-user-owned-publication
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-05
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Bun test |
| **Config file** | `package.json` and existing repository test conventions |
| **Quick run command** | `bun test tests/phase-06 --timeout 10000` |
| **Full suite command** | `bun test --timeout 10000 && bun run eval:phase06 && bun run verify:phase06-design` |
| **Estimated runtime** | ~30 seconds locally with deterministic ports |

---

## Sampling Rate

- **After every task commit:** Run the narrowest affected `tests/phase-06/*.test.ts` file, then `bun test tests/phase-06 --timeout 10000`.
- **After every plan wave:** Run `bun test --timeout 10000 && bun run eval:phase06`.
- **Before `$gsd-verify-work`:** Run `bun test --timeout 10000 && bun run eval:phase06 && bun run verify:phase06-design`; all commands must be green.
- **Max feedback latency:** 60 seconds for deterministic test and evidence generation.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-W0-01 | TBD | 0 | PREV-01 | T-06-ARTIFACT-SWAP | Only the owner-scoped durable verified artifact and exact sealed object can produce a descriptor. | contract | `bun test tests/phase-06/preview-descriptor.test.ts --timeout 10000` | ❌ W0 | ⬜ pending |
| 06-W0-02 | TBD | 0 | PREV-02 | T-06-RUNTIME-AUTHORITY | The host contract requires `sandbox="allow-scripts"` without `allow-same-origin`; untrusted messages have zero authoritative effects. | contract | `bun test tests/phase-06/runtime-status.test.ts --timeout 10000` | ❌ W0 | ⬜ pending |
| 06-W0-03 | TBD | 0 | PREV-03, PREV-04 | T-06-CAPABILITY-ESCALATION | Missing required capabilities block; missing optional capabilities degrade; neither grants direct authority. | unit | `bun test tests/phase-06/capability-review.test.ts --timeout 10000` | ❌ W0 | ⬜ pending |
| 06-W0-04 | TBD | 0 | PUB-01 | T-06-INTENT-CONFLICT | Publication approval binds one owner, artifact, d-tag, capability digest, and compatibility identity; changed inputs invalidate it. | contract | `bun test tests/phase-06/publication-intent.test.ts --timeout 10000` | ❌ W0 | ⬜ pending |
| 06-W0-05 | TBD | 0 | PUB-02, PUB-03 | T-06-SIGNATURE-SUBSTITUTION | Exact NIP-01 serialization, ID, signature, owner, tags, content, intent, and expiry are verified with generic rejection; user secret material never enters CVM. | security | `bun test tests/phase-06/manifest-signature.test.ts --timeout 10000` | ❌ W0 | ⬜ pending |
| 06-W0-06 | TBD | 0 | PUB-04 | T-06-DEPLOY-BYTE-SWAP | The promoted CLI adapter receives only persisted identities and exact sealed bytes; it cannot rebuild or accept user signing secrets. | integration | `bun test tests/phase-06/sealed-deployment.test.ts --timeout 10000` | ❌ W0 | ⬜ pending |
| 06-W0-07 | TBD | 0 | PUB-05 | T-06-DUPLICATE-EFFECT | Timeout, replay, and restart observe original operation IDs only and preserve truthful partial/pending outcomes. | integration | `bun test tests/phase-06/publication-reconciliation.test.ts --timeout 10000` | ❌ W0 | ⬜ pending |
| 06-W0-08 | TBD | 0 | PREV-01–04, PUB-01–05 | T-06-EVIDENCE-FORGERY | Design evidence is derived from deterministic fixtures; live host/signer/CLI/relay/provider observations remain explicitly `not_observed` for Phase 7. | eval | `bun run eval:phase06 && bun run verify:phase06-design` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/phase-06/preview-descriptor.test.ts` — PREV-01 exact verified-artifact descriptor and denial fixtures.
- [ ] `tests/phase-06/runtime-status.test.ts` — PREV-02 iframe/source safe-status contract and zero-authority runtime messages.
- [ ] `tests/phase-06/capability-review.test.ts` — PREV-03/PREV-04 required, optional, compatibility, and no-fallback cases.
- [ ] `tests/phase-06/publication-intent.test.ts` — PUB-01 intent, invalidation, replay, and conflict fixtures.
- [ ] `tests/phase-06/manifest-signature.test.ts` — PUB-02/PUB-03 exact event, negative crypto/binding, no-secret, no-oracle, and separate-attestation fixtures.
- [ ] `tests/phase-06/sealed-deployment.test.ts` — PUB-04 sealed-byte/hash/CLI identity continuity.
- [ ] `tests/phase-06/publication-reconciliation.test.ts` — PUB-05 duplicate, timeout, restart, partial, and original-operation observation fixtures.
- [ ] `tests/evals/phase-06-reference-set.test.ts` — deterministic Phase 6 evaluation set.
- [ ] `src/verification/phase-06-design-evidence.ts` and `scripts/verify-phase-06-design-slice.ts` — reproducible evidence with live dependencies explicitly not observed.
- [ ] Deterministic host, external signer, CLI, relay, and attestation-publisher fakes plus memory/SQLite/PostgreSQL publication-store parity coverage.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Production host renders and signs the exact manifest through a supported signer. | PREV-02, PUB-02 | Runtime and signer selection/certification are Phase 7 scope. | Phase 7 must execute the promoted runtime/signer fixture and attach observed compatibility evidence before launch. |
| Promoted CLI 0.5.2 performs supported pre-signed-template deployment against selected storage and relays. | PUB-04, PUB-05 | The pinned Linux asset and live providers are not available in the local macOS design environment. | Phase 7 must run the sealed image contract probe and live reconciliation fixtures; until then report `not_observed`, never infer success. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
