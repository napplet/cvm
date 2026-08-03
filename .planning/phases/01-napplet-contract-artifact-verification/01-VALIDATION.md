---
phase: 1
slug: napplet-contract-artifact-verification
status: draft
nyquist_compliant: false
wave_0_complete: true
created: 2026-08-03
updated: 2026-08-03
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
| 01-05-T1 | 01-05 | 5 | GEN-01, GEN-04, SAFE-05 | T-01-21/T-01-22 | Approved coherent CLI 0.5.2 release set materializes without mixed/stale inputs | `bun test tests/promotion/candidate.test.ts tests/runner/sealed-toolchain.test.ts && bun run toolchain:image-build -- --candidate toolchains/candidates/cli-0.5.2-release-set.json --verify-only` | ⬜ pending |
| 01-05-T2 | 01-05 | 5 | GEN-01, GEN-04, SAFE-05 | T-01-22/T-01-23 | Focused package-owned create/skills/build/verify/Chromium path emits artifact/aggregate/native evidence | `bun test tests/fixtures/minimal.test.ts && bun run test:promotion --fixture minimal` | ⬜ pending |
| 01-06-T1 | 01-06 | 6 | GEN-03, SAFE-06 | T-01-25 | Necessary hard storage capability and optional intent degradation pass the same Chromium path | `bun test tests/fixtures/capability-harness.test.ts && bun run test:promotion --fixture capability-harness` | ⬜ pending |
| 01-06-T2 | 01-06 | 6 | GEN-02, GEN-03, SAFE-06 | T-01-26/T-01-27 | Focused artifacts pass; representative broad/direct/service-worker/signer-relay/unnecessary-capability cases block with one owner | `bun test tests/policy/artifact-contract.test.ts` | ⬜ pending |
| 01-06-T3 | 01-06 | 6 | GEN-02, GEN-03, SAFE-06 | T-01-28/T-01-29 | Aggregate design evidence binds every positive/negative identity and labels Phase 7 gates deferred | `bun test tests/verification/design-evidence.test.ts && bun run test:design-slice` | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

## Existing and Remaining Test Assets

- [x] Root Bun/TypeScript test harness.
- [x] Immutable candidate, bounded runner, sealed image/policy, denial-probe, and evidence contracts.
- [x] Committed RED focused fixture contract in `tests/fixtures/minimal.test.ts`.
- [ ] Coherent CLI 0.5.2 sealed image inputs and green focused fixture.
- [ ] Capability harness primary/degraded Chromium path.
- [ ] Gap-ownership inventory, representative rejection cases, and aggregate design-evidence writer.

## Manual-Only Verifications

None for the revised Phase 1 tail. Candidate `a19fc7d283a4482c53728f4a931743576564fb3826d7f8fa1383d02578b69024` was already explicitly approved; D-19 forbids repeating that ritual for design execution. Formal golden, waiver, and production-promotion review belongs to Phase 7.

## Phase Sign-Off Conditions

- [ ] `bun test` passes.
- [ ] The coherent CLI 0.5.2/skills+boilerplate 0.3.2 image-input check passes with the approved candidate ID.
- [ ] Focused and capability fixtures pass their real package-native maintained verification and Chromium paths through `runSealedToolchain`.
- [ ] Representative scope/authority/capability rejection cases block with exactly-one-owner evidence.
- [ ] `evidence/design/phase-01.json` validates and binds candidate, image, skill, native report, artifact, upstream aggregate, capability, and policy identities.
- [ ] The evidence record explicitly labels exhaustive launch gates deferred to Phase 7 and exposes no production promotion/pointer authority.
- [ ] Set `nyquist_compliant: true` only after all conditions above are green.

**Approval:** pending automated execution
