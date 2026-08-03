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
| 01-W0-01 | TBD | 0 | GEN-01..04, SAFE-05..06 | T-01-01 / T-01-02 | Harness, schemas, fixtures, and sealed runner exist before feature tasks | infrastructure | `bun test` | ❌ W0 | ⬜ pending |
| 01-GEN-01 | TBD | TBD | GEN-01 | T-01-01 | Only the promoted CLI, scaffold, and installed skills create fixture sources | integration | `bun run test:promotion --fixture minimal --stage scaffold` | ❌ W0 | ⬜ pending |
| 01-GEN-02 | TBD | TBD | GEN-02 | — | Focused napplets pass; arbitrary-site, backend, and full-stack shapes reject | unit + fixture | `bun test tests/policy/scope.test.ts` | ❌ W0 | ⬜ pending |
| 01-GEN-03 | TBD | TBD | GEN-03 | T-01-03 | SDK/NAP envelopes and minimal hard `requires` pass primary and degraded shell paths | Chromium integration | `bun run test:promotion --fixture capability-harness --stage conformance` | ❌ W0 | ⬜ pending |
| 01-GEN-04 | TBD | TBD | GEN-04 | T-01-02 | Native suites pass and two clean unsigned builds match each other and the reviewed golden byte-for-byte | integration | `bun run test:promotion --fixture all` | ❌ W0 | ⬜ pending |
| 01-SAFE-05 | TBD | TBD | SAFE-05 | T-01-01 | Frozen dependencies execute without secrets, egress, floating resolution, or unbounded subprocesses | isolation integration | `bun run test:promotion --assert-hermetic` | ❌ W0 | ⬜ pending |
| 01-SAFE-06 | TBD | TBD | SAFE-06 | Direct browser/service/signer/relay authority and shell bypasses reject at source or artifact verification | unit + hostile fixture | `bun test tests/policy && bun run test:promotion --fixture hostile` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `package.json` and `tsconfig.json` — pinned Bun/TypeScript test and command surface.
- [ ] `tests/` — schema, promotion-state, evidence, policy, hermetic-runner, and fixture orchestration tests.
- [ ] `fixtures/minimal/`, `fixtures/capability-harness/`, and `fixtures/hostile/` — reviewed fixture sources and expected results.
- [ ] Sealed image definition — image-local napplet CLI/packages/Chromium, frozen offline material, no runtime registry access.
- [ ] Human-verified CLI/source/package mapping — publisher, tarball/executable integrity, source commit, and release mapping captured before candidate intake.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| First toolchain provenance approval | GEN-01, GEN-04, SAFE-05 | Registry package age and CLI release/source mapping require human trust confirmation | Review publisher identity, source commit, release asset or tarball integrity, lockfile, image digest, and captured evidence; approve the exact immutable candidate only. |
| Legitimate golden update | GEN-04 | A changed golden is a product/protocol review decision, never an automatically accepted snapshot | Inspect the complete byte/content diff, link the normative or upstream change, approve a new content-addressed golden, and verify the old promoted set remains available for rollback. |
| Emergency waiver authorization | GEN-04, SAFE-05, SAFE-06 | Only an accountable owner may accept a narrowly waivable operational failure | Confirm the failure class is waivable, candidate and report digests match, expiry and rollback trigger are present, and immutable authorization evidence names the owner. |

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
