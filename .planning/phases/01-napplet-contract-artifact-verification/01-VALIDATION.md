---
phase: 1
slug: napplet-contract-artifact-verification
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-03
updated: 2026-08-04
---

# Phase 1 — Validation Strategy

> Design-stage validation contract: prove the napplet-only architecture with representative package-native, Chromium, capability, policy, and evidence paths. Launch-grade certification remains Phase 7 work per D-17/D-18.

## Test Infrastructure

| Property | Value |
|---|---|
| **Framework** | Bun test for CVM contracts; authoritative napplet commands/suites invoked unchanged inside the sealed image |
| **Config** | `package.json`, `tsconfig.json`, sealed Docker policy/image inputs |
| **Quick command** | `bun test` |
| **Design slice command** | `bun run test:design-slice` |
| **Full Phase 1 command** | `bun test && bun run test:design-slice` |
| **Launch certification** | Phase 7: exhaustive provenance, repeated/cross-environment reproducibility, hostile/mutation matrix, goldens, waiver exercises, SBOM, production promotion |

## Sampling Rate

- After every task commit: run `bun test` plus the directly affected fixture/policy subset.
- After Plan 01-05: run `bun run test:promotion --fixture minimal` through the coherent sealed image.
- After Plan 01-06: run `bun run test:design-slice` and validate `evidence/design/phase-01.json`.
- Before Phase 1 goal verification: run `bun test && bun run test:design-slice`.
- No watch-mode commands; fast unit subsets target under 60 seconds, while real image/Chromium integration may exceed the quick-feedback budget and is sampled at plan boundaries.

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Automated Command | Status |
|---|---|---:|---|---|---|---|---|
| 01-01-T1/T2 | 01-01 | 1 | GEN-01, GEN-04, SAFE-05 | T-01-01/T-01-02/T-01-04 | Immutable manifest → bounded argv → canonical evidence fails closed | `bun test tests/tracer.test.ts tests/runner/hermetic-command.test.ts tests/evidence/bundle.test.ts` | ✅ green |
| 01-02-T1/T2 | 01-02 | 2 | GEN-01, GEN-04, SAFE-05 | T-01-01/T-01-SC | Candidate automation is immutable/read-only and cannot promote | `bun test tests/promotion/candidate.test.ts && bun run candidate:workflow-check` | ✅ green |
| 01-04-T1/T2 | 01-04 | 4 | GEN-01, GEN-04, SAFE-05 | T-01-02/T-01-10 | Sealed image, resolver denial, resource controls, DNS/HTTP/HTTPS/TCP denial | `bun test tests/runner/sealed-toolchain.test.ts && bun run test:promotion --assert-hermetic` | ✅ green |
| 01-05-T1 | 01-05 | 5 | GEN-01, GEN-04, SAFE-05 | T-01-21/T-01-22 | Approved coherent CLI 0.5.2 release set materializes without mixed/stale inputs | `bun test tests/promotion/candidate.test.ts tests/runner/sealed-toolchain.test.ts && bun run toolchain:image-build -- --candidate toolchains/candidates/cli-0.5.2-release-set.json --verify-only` | ✅ green |
| 01-05-T2 | 01-05 | 5 | GEN-01, GEN-04, SAFE-05 | T-01-22/T-01-23 | Ordered public workflow emits exact native evidence or structured blocked evidence; no native success is claimed | `bun test tests/fixtures/minimal.test.ts && bun run test:promotion --fixture minimal` | ✅ green (Phase 7 native closure deferred) |
| 01-06-T1 | 01-06 | 6 | GEN-03, SAFE-06 | T-01-25 | Storage-hard/intent-optional capability contract and degradation path | `bun test tests/fixtures/capability-harness.test.ts && bun run test:promotion --fixture capability-harness` | ✅ green (Phase 7 native closure deferred) |
| 01-06-T2 | 01-06 | 6 | GEN-02, GEN-03, SAFE-06 | T-01-26/T-01-27 | Focused artifacts pass; representative broad/direct/service-worker/signer-relay/unnecessary-capability cases block with one owner | `bun test tests/policy/artifact-contract.test.ts` | ✅ green |
| 01-06-T3 | 01-06 | 6 | GEN-02, GEN-03, SAFE-06 | T-01-28/T-01-29 | Design evidence binds identities, remains blocked when native closure is unavailable, and lists Phase 7 gates | `bun test tests/verification/design-evidence.test.ts tests/verification/phase-01-design-slice.test.ts && bun run test:design-slice` | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

## Existing and Remaining Test Assets

- [x] Root Bun/TypeScript test harness.
- [x] Immutable candidate, bounded runner, sealed image/policy, denial-probe, and evidence contracts.
- [x] Committed RED focused fixture contract in `tests/fixtures/minimal.test.ts`.
- [x] Coherent CLI 0.5.2 sealed image inputs and green focused fixture contract.
- [x] Capability harness primary/degraded contract and blocked-native evidence shape.
- [x] Gap-ownership inventory, representative rejection cases, and aggregate design-evidence writer.

## Manual-Only Verifications

The native create → init → skills → build → verify → Chromium path is intentionally **blocked** in the sealed environment because the upstream boilerplate generator clones GitHub. Automated design-slice evidence proves this is recorded as blocked, content-addressed evidence with Phase 7 closure rather than as an artifact pass. Formal golden, waiver, SBOM, provenance, cross-environment reproducibility, hostile-matrix, and production-promotion review belongs to Phase 7.

## Phase Sign-Off Conditions

- [x] `bun test` passes (57 passing tests).
- [x] The coherent CLI 0.5.2/skills+boilerplate 0.3.2 image-input check passes with the approved candidate ID.
- [x] Fixture parsing is fail-closed: accepted native reports require exact create-through-dry-run evidence; unavailable native closure emits structured blocked evidence.
- [x] Representative scope/authority/capability rejection cases block with exactly-one-owner evidence.
- [x] `evidence/design/phase-01.json` validates and binds candidate, image inputs, fixture/native evidence, capability, and policy evidence.
- [x] The evidence record explicitly labels exhaustive launch gates deferred to Phase 7 and exposes no production promotion/pointer authority.

## Nyquist Audit Trail — 2026-08-04

| Requirement | Coverage | Green behavioral evidence | Scope note |
|---|---|---|---|
| GEN-01 | COVERED | `tests/promotion/candidate.test.ts`, `tests/fixtures/minimal.test.ts`, `bun run test:promotion --fixture minimal` | Exact approved compatibility-set and ordered public workflow are enforced; native execution is truthfully blocked pending Phase 7 scaffold closure. |
| GEN-02 | COVERED | `tests/policy/artifact-contract.test.ts` | Focused-only policy rejects arbitrary/full-stack/backend shapes. |
| GEN-03 | COVERED | `tests/fixtures/capability-harness.test.ts`, `tests/policy/artifact-contract.test.ts` | Storage hard capability and SDK-only optional intent/degraded behavior are tested at the contract boundary. |
| GEN-04 | COVERED (design scope) | `tests/runner/sealed-toolchain.test.ts`, `tests/fixtures/minimal.test.ts`, `tests/verification/phase-01-design-slice.test.ts` | Pinned fail-closed build/evidence boundary is green. Native verification/Chromium execution is explicitly blocked and deferred, never claimed passed. |
| SAFE-05 | COVERED | `tests/runner/hermetic-command.test.ts`, `tests/runner/sealed-toolchain.test.ts`, `bun run test:promotion --assert-hermetic` | Literal argv, scrubbed environment, resource bounds, frozen inputs, and default-deny Docker policy are behaviorally tested. |
| SAFE-06 | COVERED | `tests/policy/artifact-contract.test.ts`, `tests/verification/design-evidence.test.ts` | Direct-authority, external asset, service-worker, signer/relay, and capability bypass evidence block fail-closed. |

New test added by this audit: `tests/verification/phase-01-design-slice.test.ts` (`7002594`) executes the design-slice command and verifies that persisted evidence remains content-addressed, `blocked`, and explicitly deferred to Phase 7. Full suite: `bun test` → 57 pass, 0 fail.

**Approval:** pending automated execution
