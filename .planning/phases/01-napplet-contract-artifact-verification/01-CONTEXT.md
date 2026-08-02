# Phase 1: Napplet Contract & Artifact Verification - Context

**Gathered:** 2026-08-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 1 defines and proves the contract that distinguishes a conformant napplet from arbitrary generated web code. It promotes one immutable, revision-pinned napplet toolchain set; composes the package-native verification and conformance suites into a thin end-to-end fixture; proves byte-stable artifact output against reviewed goldens; and emits promotion evidence.

This phase does not build the production agent service, worker isolation platform, billing, ContextVM adapter, preview product, user signing flow, or live publication system. Its publication work is limited to a non-production dry-run proving that the promoted package set composes correctly.

</domain>

<decisions>
## Implementation Decisions

### Toolchain Authority and Promotion

- **D-01:** NIP-5D is the normative authority. The napplet packages are the trusted implementation layer, but package behavior never overrides NIP-5D. If they diverge, fix the napplet packages upstream rather than introducing a napplet-cvm-specific interpretation or compatibility shim. — **Reversibility:** one-way — Reversing this would redefine the product's protocol contract and make napplet-cvm artifacts implementation-specific instead of NIP-5D conformant.
- **D-02:** Keep production on the last known-good promoted set while a broken candidate is quarantined and fixed upstream.
- **D-03:** Detect and test new NIP-5D/package candidates automatically, but require explicit reviewed promotion before production adopts them.
- **D-04:** Each promoted set has a full immutable promotion manifest that pins the NIP-5D revision, relevant NAP revisions, package versions and integrity hashes, lockfile, scaffold revision, build-image digest, runtime version, and Chromium/conformance version. — **Reversibility:** costly — Reducing this identity later would break auditability and make older golden/evidence bundles ambiguous.
- **D-05:** When NIP-5D advances before the napplet packages, the current production set remains explicitly pinned to its recorded NIP-5D revision. The new revision is a promotion candidate and is not claimed as supported until upstream packages and fixtures pass.

### Reference Fixture Coverage

- **D-06:** Use a small contract matrix: a minimal valid napplet, a representative synthetic capability harness, and focused invalid/hostile cases.
- **D-07:** The synthetic capability harness is the representative positive integration fixture. Its purpose is to exercise cross-package composition, not to become a second conformance implementation.
- **D-08:** Run the napplet packages' native unit, manifest, CLI, reference-shell, and conformance suites unchanged. Napplet-cvm adds only thin end-to-end composition tests and contract gaps not already owned upstream.
- **D-09:** Negative coverage may include both prohibited source inputs and post-build artifact mutations, but only where an equivalent upstream package assertion does not already exist.

### Reproducibility Standard

- **D-10:** Identical source plus the same immutable promotion manifest must emit byte-identical unsigned `dist` content and the same aggregate hash. Behaviorally equivalent but byte-different output is a failure. — **Reversibility:** costly — Artifact identity, reviewed goldens, and downstream attestations will depend on this byte-level contract.
- **D-11:** Timestamps, signatures, relay receipts, and deployment metadata remain outside the sealed artifact and reference its aggregate hash; they never mutate promoted `dist` bytes.
- **D-12:** A clean candidate build is compared against a stored content-addressed golden artifact and expected aggregate hash.
- **D-13:** A legitimate golden change requires an explicit reviewed artifact diff and promotion update. Passing package suites cannot regenerate or replace goldens automatically.

### Failure and Evidence Contract

- **D-14:** Every NIP-5D/NAP normative violation, package-native suite failure, integration-fixture failure, forbidden-authority finding, golden mismatch, aggregate-hash mismatch, or unverifiable provenance blocks promotion by default.
- **D-15:** Every promotion run produces a layered evidence bundle: concise human verdict, machine-readable results, immutable promotion manifest, package-native reports, integration results, artifact and golden hashes, reproducibility diff, and provenance links.
- **D-16:** An emergency owner waiver may override a hard blocker. The authorization identity, non-waivable failure classes, expiry, evidence, rollback trigger, and enforcement mechanism are delegated to Phase 1 research and planning. — **Reversibility:** costly — Waiver records can permit a nonconforming set into production and therefore must remain auditable for the lifetime of any affected artifact.

### the agent's Discretion

- Choose the exact synthetic capability-harness domains, provided they exercise meaningful cross-package behavior without duplicating upstream suites.
- Choose the exact uncovered negative/mutation cases after performing an upstream coverage inventory.
- Define the machine-readable evidence schemas and CI presentation while preserving the required layered bundle.
- Define promotion-candidate detection, evidence retention, and golden storage mechanics.
- Research and plan the emergency owner-waiver mechanism within D-16; do not remove the owner-waiver capability or weaken the default hard-blocking policy.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Scope and Requirements

- `.planning/PROJECT.md` — Permanent napplet-only boundary, security constraints, and project-level decisions.
- `.planning/REQUIREMENTS.md` — Phase 1 requirements `GEN-01` through `GEN-04`, `SAFE-05`, and `SAFE-06`.
- `.planning/ROADMAP.md` — Phase 1 goal, success criteria, dependency position, and validation gate.
- `.planning/research/SUMMARY.md` — Toolchain provenance risk, recommended validation order, and research flags.

### Normative Protocol

- `https://github.com/nostr-protocol/nips/pull/2303` — NIP-5D is the normative contract for napplet transport, sandboxing, identity, and capability negotiation. Pin the exact reviewed revision in every promotion manifest.

### Trusted Upstream Package Implementation

- `../napplet/packages/conformance/src/validators/manifest.ts` — Upstream manifest validation; reuse rather than copying.
- `../napplet/packages/conformance/src/shell/reference-shell.ts` — Upstream reference-shell behavior used by native conformance coverage.
- `../napplet/packages/cli/src/manifest.ts` — Upstream manifest collection, hashing, and deploy-template behavior.
- `../napplet/packages/cli/tests/deploy_network_test.ts` — Existing CLI deployment/network coverage that the thin integration layer must compose, not duplicate.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- Current `napplet-cvm` workspace: no application source exists yet; Phase 1 starts greenfield.
- Upstream `../napplet/packages/conformance`: manifest validators and reference shell already own core protocol/conformance assertions.
- Upstream `../napplet/packages/cli`: manifest hashing/deploy behavior and deployment-network tests already own CLI correctness.

### Established Patterns

- Package-native tests are authoritative implementation coverage beneath NIP-5D; napplet-cvm composes them rather than vendoring or rewriting them.
- Artifact identity is aggregate-hash/content based, so signing and deployment metadata must remain outside deterministic application bytes.
- Promotion is explicit and evidence-backed; runtime dependency resolution must never float to an unreviewed candidate.

### Integration Points

- New Phase 1 code should call public napplet package commands/interfaces and their native scripts rather than importing private validators solely to reproduce upstream tests.
- The promotion manifest, golden fixture store, thin synthetic harness, and layered evidence bundle are new napplet-cvm-owned surfaces.
- No existing napplet-cvm architecture constrains file layout or implementation language beyond the project-level TypeScript/Bun research recommendation; the planner may choose the smallest structure that preserves these contracts.

</code_context>

<specifics>
## Specific Ideas

- “NIP-5D is god.” Package behavior follows the spec, not the reverse.
- Trust the napplet packages and fix defects in those packages upstream.
- Avoid test duplication: the CVM proves composition and fills only demonstrated gaps.
- Use a synthetic capability harness rather than a product-like Note Drafts or social-feed example as the representative integration fixture.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 1-Napplet Contract & Artifact Verification*
*Context gathered: 2026-08-03*
