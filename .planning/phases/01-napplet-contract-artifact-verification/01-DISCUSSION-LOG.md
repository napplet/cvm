# Phase 1: Napplet Contract & Artifact Verification - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-03
**Phase:** 1-Napplet Contract & Artifact Verification
**Areas discussed:** Toolchain promotion policy, Reference fixture coverage, Reproducibility standard, Failure and evidence contract

---

## Toolchain Promotion Policy

### Authority under upstream drift

| Option | Description | Selected |
|--------|-------------|----------|
| Tested compatibility set | Upstream sources define intent; deploy only an exact set that passes the complete fixture. | |
| Published packages first | Treat latest npm/JSR releases as authoritative until tests prove them broken. | |
| Source repository first | Build from the official source branch when releases lag. | |
| Freeform | NIP-5D is normative; trusted napplet packages must chase it and be fixed when they diverge. | ✓ |

**User's choice:** “NIP-5D is god. But napplet packages chase NIP-5D, and we trust napplet packages. When something goes wrong, we fix the napplet packages.”
**Notes:** Do not add a napplet-cvm-specific compatibility interpretation or local behavior that contradicts NIP-5D.

### Behavior while upstream is fixed

| Option | Description | Selected |
|--------|-------------|----------|
| Keep last known-good set | Quarantine the broken candidate and retain the promoted versions until an upstream fix passes. | ✓ |
| Block all generation | Stop generation until the latest set conforms. | |
| Temporary local patch | Carry a short-lived napplet-cvm patch while upstream review proceeds. | |

**User's choice:** Keep last known-good set.
**Notes:** Fixes belong upstream in the napplet packages.

### Candidate promotion

| Option | Description | Selected |
|--------|-------------|----------|
| Automatic candidate, explicit promotion | Detect/test candidates automatically, then require a reviewed promotion. | ✓ |
| Automatic promotion | Switch production whenever the complete suite passes. | |
| Scheduled updates | Evaluate candidates only during maintenance windows. | |

**User's choice:** Automatic candidate, explicit promotion.

### Promoted-set identity

| Option | Description | Selected |
|--------|-------------|----------|
| Full immutable promotion manifest | Pin protocol/NAP revisions, package integrity, lockfile, scaffold, image, runtime, and browser/conformance versions. | ✓ |
| Packages and lockfile | Record only package versions, integrity, and dependency lockfile. | |
| Release label only | Resolve a named compatibility release from registries at runtime. | |

**User's choice:** Full immutable promotion manifest.

---

## Reference Fixture Coverage

### Fixture topology

| Option | Description | Selected |
|--------|-------------|----------|
| Small contract matrix | Minimal valid fixture, representative positive fixture, and focused invalid corpus. | ✓ |
| One canonical napplet | One project passes every toolchain stage. | |
| One fixture per NAP | Positive fixture for every supported capability domain. | |

**User's choice:** Small contract matrix.

### Representative valid fixture

| Option | Description | Selected |
|--------|-------------|----------|
| Official Note Drafts example | Use a first-party example as the end-to-end fixture. | |
| Small social feed | Exercise identity, event reads, theming, and shell mediation. | |
| Synthetic capability harness | Exercise several package/API boundaries for contract coverage. | ✓ |

**User's choice:** Synthetic capability harness.

### Invalid corpus

| Option | Description | Selected |
|--------|-------------|----------|
| Source and built-artifact attacks | Test prohibited source plus post-build mutations and identity/capability mismatches. | ✓ |
| Source violations only | Reject prohibited code before building. | |
| Built-artifact mutations only | Treat emitted bytes as the sole boundary. | |

**User's choice:** Source and built-artifact attacks.

### Upstream coverage ownership

| Option | Description | Selected |
|--------|-------------|----------|
| Duplicate coverage in napplet-cvm | Recreate package-native conformance, CLI, and manifest assertions locally. | |
| Compose upstream suites | Run package-native suites unchanged and add only cross-package composition or demonstrated gaps. | ✓ |

**User's choice:** Compose upstream suites.
**Notes:** The user corrected the initial environment-oriented question because napplet packages already own substantial verification coverage. The upstream graph confirmed manifest validators, aggregate-hash verification, a reference shell, CLI deployment/network tests, and conformance checks. The final decision is explicitly to avoid duplicating these assertions.

---

## Reproducibility Standard

### Reproducibility bar

| Option | Description | Selected |
|--------|-------------|----------|
| Byte-identical artifact | Same source and promoted inputs produce identical unsigned bytes and aggregate hash. | ✓ |
| Hash-stable manifest only | Require stable identity while allowing other output differences. | |
| Behaviorally equivalent | Accept different hashes when both outputs conform. | |

**User's choice:** Byte-identical artifact.

### Nondeterministic publication data

| Option | Description | Selected |
|--------|-------------|----------|
| Outside the artifact | Signatures, timestamps, receipts, and deployment metadata reference the sealed hash. | ✓ |
| Deterministic test values | Embed fixed publication values during promotion. | |
| Permit signed-output variance | Allow the publication bundle to differ between runs. | |

**User's choice:** Outside the artifact.

### Reproducibility proof

| Option | Description | Selected |
|--------|-------------|----------|
| Two fresh isolated builds | Compare two clean builds from the same manifest. | |
| Golden comparison | Compare a clean candidate build with a stored artifact/hash. | ✓ |
| Cross-platform comparison | Require byte parity across Linux and macOS. | |

**User's choice:** Golden comparison.

### Golden updates

| Option | Description | Selected |
|--------|-------------|----------|
| Reviewed golden update | Store the full content-addressed golden and require an explicit reviewed diff. | ✓ |
| Hash-only update | Store and review expected hashes only. | |
| Automatic regeneration | Let passing package suites replace goldens automatically. | |

**User's choice:** Reviewed golden update.

---

## Failure and Evidence Contract

### Hard blockers

| Option | Description | Selected |
|--------|-------------|----------|
| All contract failures | Block normative, package-suite, integration, authority, golden/hash, and provenance failures. | ✓ |
| Security failures only | Permit non-security conformance/reproducibility/provenance exceptions. | |
| Severity threshold | Block only critical/high findings. | |

**User's choice:** All contract failures.

### NIP-5D transition

| Option | Description | Selected |
|--------|-------------|----------|
| Revision-pinned continuity | Keep the promoted revision while a new revision and package set are validated. | ✓ |
| Immediate shutdown | Stop generation when latest NIP-5D advances. | |
| Dual compatibility profiles | Expose old and experimental profiles simultaneously. | |

**User's choice:** Revision-pinned continuity.

### Evidence bundle

| Option | Description | Selected |
|--------|-------------|----------|
| Layered evidence bundle | Human verdict, machine results, manifest, native/integration reports, hashes, diff, and provenance. | ✓ |
| Human report only | Markdown report with external logs. | |
| Machine report only | JSON/JUnit/SARIF for automation. | |

**User's choice:** Layered evidence bundle.

### Hard-blocker waivers

| Option | Description | Selected |
|--------|-------------|----------|
| No hard-blocker waivers | Only warnings may be acknowledged. | |
| Emergency owner waiver | Allow a time-limited owner override with rollback controls. | ✓ |
| Maintainer consensus | Permit a blocker after multi-maintainer approval. | |

**User's choice:** Emergency owner waiver.
**Notes:** The user chose not to discuss waiver mechanics further. Research/planning may define owner identity, non-waivable classes, expiry, evidence, enforcement, and rollback while preserving the existence of an owner waiver and the default fail-closed policy.

---

## the agent's Discretion

- Exact synthetic harness NAP domains.
- Exact negative/mutation cases after upstream coverage inventory.
- Machine-readable evidence formats and CI presentation.
- Candidate detection, evidence retention, and golden-storage mechanics.
- Emergency owner-waiver mechanics within the locked policy.

## Deferred Ideas

None.
