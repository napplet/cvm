---
phase: 01-napplet-contract-artifact-verification
verified: 2026-08-04T09:00:37Z
status: passed
score: 4/4 must-haves verified
behavior_unverified: 0
overrides_applied: 0
deferred:
  - truth: "A sealed native scaffold completes the real create → init → skills → build → verify → Chromium path."
    addressed_in: "Phase 7"
    evidence: "The current boilerplate generator clones GitHub under network=none; Phase 7 explicitly owns compatible sealed-scaffold closure and final launch safety."
  - truth: "Production promotion certification covers exhaustive provenance, reproducibility, hostile matrices, goldens, waiver drills, and SBOM enforcement."
    addressed_in: "Phase 7"
    evidence: "D-18 and the Phase 7 roadmap explicitly defer these launch gates."
---

# Phase 1: Napplet Contract & Artifact Verification — Verification Report

**Phase Goal:** Establish an executable napplet-only artifact contract and prove one representative NIP-5D creation/verification path that downstream product phases can build on.

**Verified:** 2026-08-04T09:00:37Z

**Status:** passed — at the explicit D-17/D-18 design-stage scope.

## Goal Achievement

The source implements a fail-closed contract and representative fixture/evidence pipeline. The aggregate design record is intentionally `blocked`: it records, rather than conceals, that the upstream boilerplate generator clones GitHub and cannot complete inside the sealed no-network environment. Per the Phase 1 authority supplied for this verification, that honest native limitation is a Phase 7 deferred item, not a Phase 1 gap or a conformant-artifact claim.

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | The representative path is restricted to the approved CLI/skills/boilerplate compatibility set and exact ordered napplet workflow. | ✓ VERIFIED | `runFixture` fixes candidate `a19fc…9024`, accepts only the nine create-through-dry-run stages, and invokes `/toolchain/bin/fixture-runner` solely through `runSealedToolchain`; input verification binds the 0.5.2/0.3.2 package set and lockfile. |
| 2 | Artifact/native evidence is fail-closed and never turns a blocked native fixture into a conformant artifact. | ✓ VERIFIED | `parseRunnerOutput` permits a blocked result only with a structured reason; `evaluateDesignVerification` propagates a blocked native fixture to a `blocked` design verdict. `bun run test:design-slice` emitted exactly that result. |
| 3 | Focused napplets and necessary SDK capabilities are distinguished from representative scope and direct-authority violations. | ✓ VERIFIED | `evaluateArtifactContract` rejects full-stack/backend, service-worker, signer/relay, dynamic-authority, malformed upstream evidence, and unnecessary/unknown capabilities; the storage-hard/intent-optional harness uses `requireDomain`. |
| 4 | Dependency/build execution has a bounded, default-deny boundary with no inherited secrets or unrestricted runtime network. | ✓ VERIFIED | `runHermeticCommand` takes literal argv, scrubs inherited environment, enforces timeout/output bounds; `runSealedToolchain` derives closed Docker arguments with `--network=none`, read-only root, dropped capabilities, non-root user, resource limits, and candidate-ID binding. |

**Score:** 4/4 truths verified.

### Deferred Items

| Item | Addressed In | Evidence |
| --- | --- | --- |
| Real native package/Chromium closure with a compatible content-addressed scaffold | Phase 7 | The real boilerplate generator clones GitHub, which sealed execution correctly denies; `evidence/design/phase-01.json` remains `blocked` and names Phase 7. |
| Exhaustive certification and production-promotion controls | Phase 7 | `DEFERRED_LAUNCH_GATES` names provenance, reproducibility, hostile/mutation, goldens, waiver, SBOM, and production-promotion work. |

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/promotion/schema.ts` | Immutable full promotion-manifest parser | ✓ VERIFIED | Requires exact package pins, absolute executable paths, all identity pins, and canonical toolchain identity. |
| `src/runner/hermetic-command.ts` | Bounded argv-only execution | ✓ VERIFIED | Digest-validates executable, uses `Bun.spawn([executable, ...argv])`, and captures canonical evidence. |
| `src/runner/sealed-toolchain.ts` | Single sealed execution boundary | ✓ VERIFIED | Validates closed policy and candidate identity before constructing Docker argv. |
| `src/fixtures/registry.ts` | Structured focused/capability fixture results | ✓ VERIFIED | Strict stage ordering, digest checks, capability observations, and blocked-result semantics are wired to the sealed runner. |
| `src/policy/artifact-contract.ts` | Gap-only napplet policy | ✓ VERIFIED | Consumes immutable upstream verdicts and applies only inventory-owned CVM gaps. |
| `src/verification/design-evidence.ts` | Canonical design record | ✓ VERIFIED | Produces immutable `design-ready` or `blocked` evidence; waivers are rejected in design profile and launch gates stay explicit. |
| `evidence/design/phase-01.json` | Current representative design record | ✓ VERIFIED | Content-addressed record exists and accurately says `verdict: blocked`, never a fabricated pass. |

All Phase 1 plan-frontmatter artifact checks passed: 20/20 substantive artifacts. The two automated key-link false negatives were pattern limitations: `verifyToolchainImageInputs` explicitly reads the candidate, policy, Dockerfile, and lockfile together and rejects mismatches; the 0.5.2/0.3.2 values are bound through that parsed input rather than a textual regex in the Dockerfile.

### Key Link Verification

| From | To | Status | Details |
| --- | --- | --- | --- |
| Promotion tracer | Manifest parser, sealed runner, evidence bundle | ✓ WIRED | `runPromotionCandidate` parses first, runs denial probes/stages through `runSealedToolchain`, and writes blocking evidence on every failure path. |
| Candidate record | Policy/Dockerfile/lockfile | ✓ WIRED | `verifyToolchainImageInputs` checks review readiness, matching candidate ID, exact package integrities, CLI asset checksum, and no `npx` fallback. |
| Fixture registry | Sealed toolchain | ✓ WIRED | `runFixture` is the only fixture host-to-container path and requires a passed sealed wrapper result before parsing fixture output. |
| Capability source/fixture | Policy and design evidence | ✓ WIRED | Fixture metadata, runtime observations, `evaluateArtifactContract`, and `writeDesignVerificationEvidence` are exercised by focused Bun tests and the design-slice command. |

### Requirements Coverage

| Requirement | Status | Evidence |
| --- | --- | --- |
| GEN-01 | ✓ SATISFIED (design scope) | Approved candidate, exact frozen package inputs, ordered CLI/skills fixture contract, and no native pass claim when sealed creation blocks. |
| GEN-02 | ✓ SATISFIED | Focused-only policy rejects full-stack/backend and second-purpose shapes with deterministic evidence. |
| GEN-03 | ✓ SATISFIED | Capability harness declares `storage` as its only hard capability and uses optional `intent` through public SDK with a tested degraded path. |
| GEN-04 | ✓ SATISFIED (design scope) | Pinned inputs, maintained command contracts, forbidden-authority policy, and native/Chromium evidence shape fail closed; real closure is explicitly deferred, not claimed. |
| SAFE-05 | ✓ SATISFIED | Pinned lock/image inputs, argv-only runner, explicit scrubbed environment, resource ceilings, no resolver fallback, and default-deny network policy. |
| SAFE-06 | ✓ SATISFIED | Representative direct-authority, external-asset, service-worker, signer/relay, and capability cases block with exactly-one-owner evidence. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- |
| Full Phase 1 contract suite | `bun test` | 56 pass, 0 fail | ✓ PASS |
| Aggregate design evidence | `bun run test:design-slice` | `verdict: blocked`, with explicit native-runtime reason | ✓ PASS |
| Hermetic promotion boundary | `bun run test:promotion --assert-hermetic` | 12 pass, 0 fail | ✓ PASS |
| Minimal fixture contract | `bun run test:promotion --fixture minimal` | Input verification plus 20 passing contract tests | ✓ PASS |
| Capability fixture contract | `bun run test:promotion --fixture capability-harness` | Input verification plus 15 passing contract tests | ✓ PASS |

### Anti-Patterns Found

No untracked implementation changes, placeholder implementations, or unreferenced `TBD`/`FIXME`/`XXX` markers were found in Phase 1 source. The only `return null`/empty-record matches are defensive parser branches, not user-visible stubs.

---

_Verifier conclusion: Phase 1 has achieved its stated executable design boundary. Its blocked design record is correct, evidence-bearing fail-closed behavior; it must not be relabeled as a verified native artifact before Phase 7 closes the scaffold/runtime dependency._
