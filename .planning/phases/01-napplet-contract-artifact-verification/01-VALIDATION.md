---
phase: 1
slug: napplet-contract-artifact-verification
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-03
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Bun test for CVM-owned runner, policy, schema, and evidence tests; upstream napplet suites invoked unchanged |
| **Config file** | `package.json` and `tsconfig.json` — Wave 0 installs |
| **Quick run command** | `bun test` plus the fixture subset changed by the task |
| **Full suite command** | `bun test && bun run test:promotion` inside the pinned sealed image |
| **Estimated runtime** | Quick suite under 60 seconds; full sealed promotion run measured during Wave 0 |

---

## Sampling Rate

- **After every task commit:** Run `bun test` plus the affected fixture subset.
- **After every plan wave:** Run `bun test && bun run test:promotion` inside the pinned sealed image.
- **Before `$gsd-verify-work`:** Full suite, upstream-native suites, two-clean-build comparison, golden comparison, and Chromium conformance must be green.
- **Max feedback latency:** 60 seconds for the quick suite; sealed integration latency is recorded and bounded after Wave 0 measurement.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-01-T1 | 01-01 | 1 | GEN-01, GEN-04, SAFE-05 | T-01-01 / T-01-02 | Candidate manifest reaches bounded argv execution and canonical fail-closed evidence | tracer | `bun test tests/tracer.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-T1 | 01-02 | 2 | GEN-01, GEN-04, SAFE-05 | T-01-01 / T-01-15 | Candidate facts are canonical, evidence-bound, and unable to install/promote | unit + workflow | `bun test tests/promotion/candidate.test.ts && bun run candidate:verify -- toolchains/candidates/initial.json` | ❌ W0 | ⬜ pending |
| 01-04-T2 | 01-04 | 4 | GEN-04, SAFE-05 | T-01-02 / T-01-10 | Exact promotion container runs with no network/capabilities/secrets and bounded resources; DNS/HTTP/HTTPS/raw TCP probes deny | isolation integration | `bun test tests/runner/sealed-toolchain.test.ts && bun run test:promotion --assert-hermetic` | ❌ W0 | ⬜ pending |
| 01-05-T1 | 01-05 | 5 | GEN-01 | T-01-02 / T-01-09 | Only promoted CLI, scaffold, installed skills, and sealed stage order create fixture sources | integration | `bun run test:promotion --fixture minimal --stage scaffold` | ❌ W0 | ⬜ pending |
| 01-05-T2 | 01-05 | 5 | GEN-03 | T-01-03 / T-01-10 | Same-candidate NAP revisions/domains and minimal hard requirements pass primary and degraded shell paths | Chromium integration | `bun run test:promotion --fixture capability-harness --stage conformance` | ❌ W0 | ⬜ pending |
| 01-06-T1 | 01-06 | 6 | GEN-02, SAFE-05 | T-01-11 / T-01-12 | Focused napplets pass; arbitrary-site, backend, full-stack, and unknown dependency/build shapes block | unit | `bun test tests/policy/scope.test.ts tests/policy/dependency.test.ts` | ❌ W0 | ⬜ pending |
| 01-07-T1 | 01-07 | 6 | GEN-04 | T-01-04 / T-01-14 | Two clean unsigned builds match each other and reviewed/pending golden identity byte-for-byte or block for upstream remediation | integration | `bun test tests/evidence/golden.test.ts && bun run test:promotion --fixture all --stage reproducibility` | ❌ W0 | ⬜ pending |
| 01-08-T1 | 01-08 | 7 | GEN-02, GEN-03, GEN-04, SAFE-05, SAFE-06 | T-01-03 / T-01-10 / T-01-12 | Native-first hostile and mutation cases block under serial/concurrent sealed execution | unit + hostile fixture | `bun test tests/policy tests/evidence/golden.test.ts tests/fixtures/hostile.test.ts && bun run test:promotion --fixture hostile` | ❌ W0 | ⬜ pending |
| 01-09-T1 | 01-09 | 8 | GEN-04, SAFE-05, SAFE-06 | T-01-05 / T-01-15 | State transitions and waivers retain every hard blocker and preserve last-known-good | unit | `bun test tests/promotion/state.test.ts tests/policy/waiver.test.ts` | ❌ W0 | ⬜ pending |
| 01-11-T2 | 01-11 | 10 | GEN-01..04, SAFE-05..06 | T-01-15 / T-01-18 | Exact approved manifest/golden/evidence tuple reproduces from current pointer | full integration | `bun test && bun run test:promotion --from-current` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `package.json` and `tsconfig.json` — pinned Bun/TypeScript test and command surface.
- [ ] `tests/` — schema, promotion-state, evidence, policy, hermetic-runner, and fixture orchestration tests.
- [ ] `fixtures/minimal/`, `fixtures/capability-harness/`, and `fixtures/hostile/` — reviewed fixture sources and expected results.
- [ ] Sealed image definition and wrapper — image-local napplet CLI/packages/Chromium, frozen offline material, parsed Docker isolation policy, and no runtime registry/egress path.
- [ ] Human-verified CLI/source/package mapping in Plan 03 — publisher, tarball/executable integrity, source commit, and release mapping captured before candidate image intake.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Plan 03 exact toolchain provenance approval | GEN-01, GEN-04, SAFE-05 | Registry package age and CLI distribution/source mapping require human trust confirmation | Review publisher identity, authoritative source commit, release asset/tarball and executable integrity, lock/image/runtime pins, and captured evidence; approve the exact immutable candidate ID only. |
| Plan 10 exact evidence and golden approval | GEN-04 | Candidate evidence, selected NAP revisions/domains, and changed/initial golden bytes are product/protocol review facts, never automatically accepted snapshots | Inspect the complete bundle and byte/content diff, confirm the same-candidate NAP/domain evidence and every aggregate/object digest, approve the exact tuple, and verify the old promoted set remains available for rollback. |
| Plan 10 waiver evidence approval (only when present) | GEN-04, SAFE-05, SAFE-06 | Only an accountable owner may accept a narrowly waivable operational failure within the exact evidence/golden decision | Confirm the failure class is waivable, candidate/check/report digests match, expiry and rollback trigger are present, and immutable authorization evidence names the owner; reject every non-waivable class. |

---

## Validation Sign-Off

- [ ] All tasks have automated verification or explicit Wave 0 dependencies.
- [ ] Sampling continuity: no three consecutive tasks without automated verification.
- [ ] Wave 0 covers every missing test or fixture reference.
- [ ] No watch-mode flags.
- [ ] Quick feedback latency is under 60 seconds.
- [ ] Full sealed-run duration and resource ceiling are recorded.
- [ ] `nyquist_compliant: true` is set in frontmatter after validation.

**Approval:** pending
