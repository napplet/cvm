# Phase 1: Napplet Contract & Artifact Verification - Research

**Researched:** 2026-08-03
**Domain:** NIP-5D/NIP-5A contract conformance, reproducible napplet toolchain promotion, and artifact verification
**Confidence:** MEDIUM

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Toolchain Authority and Promotion

- **D-01:** NIP-5D is the normative authority. The napplet packages are the trusted implementation layer, but package behavior never overrides NIP-5D. If they diverge, fix the napplet packages upstream rather than introducing a napplet-cvm-specific interpretation or compatibility shim. — **Reversibility:** one-way — Reversing this would redefine the product's protocol contract and make napplet-cvm artifacts implementation-specific instead of NIP-5D conformant.
- **D-02:** Keep production on the last known-good promoted set while a broken candidate is quarantined and fixed upstream.
- **D-03:** Detect and test new NIP-5D/package candidates automatically, but require explicit reviewed promotion before production adopts them.
- **D-04:** Each promoted set has a full immutable promotion manifest that pins the NIP-5D revision, relevant NAP revisions, package versions and integrity hashes, lockfile, scaffold revision, build-image digest, runtime version, and Chromium/conformance version. — **Reversibility:** costly — Reducing this identity later would break auditability and make older golden/evidence bundles ambiguous.
- **D-05:** When NIP-5D advances before the napplet packages, the current production set remains explicitly pinned to its recorded NIP-5D revision. The new revision is a promotion candidate and is not claimed as supported until upstream packages and fixtures pass.

#### Reference Fixture Coverage

- **D-06:** Use a small contract matrix: a minimal valid napplet, a representative synthetic capability harness, and focused invalid/hostile cases.
- **D-07:** The synthetic capability harness is the representative positive integration fixture. Its purpose is to exercise cross-package composition, not to become a second conformance implementation.
- **D-08:** Run the napplet packages' native unit, manifest, CLI, reference-shell, and conformance suites unchanged. Napplet-cvm adds only thin end-to-end composition tests and contract gaps not already owned upstream.
- **D-09:** Negative coverage may include both prohibited source inputs and post-build artifact mutations, but only where an equivalent upstream package assertion does not already exist.

#### Reproducibility Standard

- **D-10:** Identical source plus the same immutable promotion manifest must emit byte-identical unsigned `dist` content and the same aggregate hash. Behaviorally equivalent but byte-different output is a failure. — **Reversibility:** costly — Artifact identity, reviewed goldens, and downstream attestations will depend on this byte-level contract.
- **D-11:** Timestamps, signatures, relay receipts, and deployment metadata remain outside the sealed artifact and reference its aggregate hash; they never mutate promoted `dist` bytes.
- **D-12:** A clean candidate build is compared against a stored content-addressed golden artifact and expected aggregate hash.
- **D-13:** A legitimate golden change requires an explicit reviewed artifact diff and promotion update. Passing package suites cannot regenerate or replace goldens automatically.

#### Failure and Evidence Contract

- **D-14:** Every NIP-5D/NAP normative violation, package-native suite failure, integration-fixture failure, forbidden-authority finding, golden mismatch, aggregate-hash mismatch, or unverifiable provenance blocks promotion by default.
- **D-15:** Every promotion run produces a layered evidence bundle: concise human verdict, machine-readable results, immutable promotion manifest, package-native reports, integration results, artifact and golden hashes, reproducibility diff, and provenance links.
- **D-16:** An emergency owner waiver may override a hard blocker. The authorization identity, non-waivable failure classes, expiry, evidence, rollback trigger, and enforcement mechanism are delegated to Phase 1 research and planning. — **Reversibility:** costly — Waiver records can permit a nonconforming set into production and therefore must remain auditable for the lifetime of any affected artifact.

### the agent's Discretion

- Choose the exact synthetic capability-harness domains, provided they exercise meaningful cross-package behavior without duplicating upstream suites.
- Choose the exact uncovered negative/mutation cases after performing an upstream coverage inventory.
- Define the machine-readable evidence schemas and CI presentation while preserving the required layered bundle.
- Define promotion-candidate detection, evidence retention, and golden storage mechanics.
- Research and plan the emergency owner-waiver mechanism within D-16; do not remove the owner-waiver capability or weaken the default hard-blocking policy.

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

## Phase Requirements

| ID | Description | Research Support |
|---|---|---|
| GEN-01 | Scaffold only through the promoted authoritative CLI/boilerplate set and installed skills. | Promote a CLI/scaffold/skills image identity; fixture invokes `create → init → skills install` and retains outputs. |
| GEN-02 | Produce only a small, focused NIP-5D napplet/nsite. | Admission/policy fixture rejects arbitrary site, full-stack, and generated-backend shapes before promotion. |
| GEN-03 | Use promoted SDK/NAP interfaces and declare only necessary hard capabilities. | Synthetic harness asserts SDK-mediated envelopes and minimal bare-domain `requires` tags. |
| GEN-04 | Reproducible pinned build, maintained verification, authority checks, Chromium conformance. | Two clean unsigned builds, aggregate/hash/golden comparison, native `verify`, and `test:conformance` reports are promotion gates. |
| SAFE-05 | Pinned, policy-checked, resource-bounded dependency/build execution without secrets or open network. | Hermetic image, frozen lockfile/offline build, no `npx`, process budget, and scrubbed environment are required. |
| SAFE-06 | Reject direct browser/service authority and shell bypasses. | Retain upstream forbidden-global scan and add only its documented gap cases: service workers, dynamic authority lookup/code generation, app-owned signing/relay libraries, and post-build mutations. |

## Project Constraints (from AGENTS.md)

- Prefer the `codebase-memory-mcp` graph tools for code discovery; use shell search only for literals, config, or insufficient graph results.
- The permanent product boundary is a small, single-purpose sandboxed napplet; do not plan arbitrary websites, generated backends, or direct browser/network/storage/signer/relay authority.
- Use `@napplet/cli` and its deployment/manifest contract rather than recreating publication logic.
- Treat prompts, generated code, package/tool output, and runtime messages as untrusted; plan layered validation and containment.
- Do not introduce direct repository edits outside the GSD workflow. [VERIFIED: AGENTS.md]

## Summary

NIP-5D is still an open, changing pull request, currently headed by `eb45dfd7335b7f88cb53781984c553581d2b4c34` as checked on 2026-08-03. It defines the napplet boundary: an `allow-scripts` opaque-origin iframe; `postMessage` envelope transport; identity bound by `MessageEvent.source` to the NIP-5A `(d-tag, aggregate-hash)` tuple; manifest-declared bare NAP requirements; and no `window.nostr` inside the iframe. The proposal assigns specific message domains to NAPs rather than to NIP-5D itself. [CITED: https://github.com/nostr-protocol/nips/pull/2303]

The sibling authoritative implementation already separates the correct concerns: the CLI owns create/init/deploy planning, the Vite plugin computes path and aggregate hashes, the conformance CLI uses real Playwright Chromium plus a reference shell, and the skills prescribe the agent workflow. napplet-cvm should execute those public surfaces unchanged and record their reports; it must not fork validators or write a compatibility interpretation. The one justified CVM-owned layer is promotion orchestration: hermetic invocation, fixture composition, reproducibility/golden comparison, evidence storage, and explicitly documented policy gaps. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source]

The immediate risk is supply-chain/provenance drift. The installed upstream repository describes a CLI at version `0.5.0`, while npm reports `@napplet/cli@0.0.0`; the registry also points different packages to `napplet/napplet` and `sandwichfarm/napplet`. Furthermore, the CLI's default conformance command uses `npx`. Phase 1 must therefore establish one reviewed image-local executable and frozen lockfile before it may call any toolchain set “promoted”; do not run `npx`, curl installers, or package resolution during a sealed build. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source; VERIFIED: npm registry]

**Primary recommendation:** Build a small TypeScript/Bun promotion harness that treats a promoted toolchain manifest plus its content-addressed golden fixture as the only input authority, runs upstream tools unchanged inside a no-network/no-secrets image, and emits a signed-like immutable evidence bundle before switching the `current` promoted-set pointer. [ASSUMED]

## Contract Classification

| Class | Phase-1 decision |
|---|---|
| Hard contract | NIP-5D/NIP-5A revision, opaque sandbox, NAP-only authority, native package suites unchanged, reproducible unsigned bytes, aggregate hash, pinned provenance, default blocking. [CITED: https://github.com/nostr-protocol/nips/pull/2303] |
| Recommended implementation | A TypeScript/Bun promotion runner, JSON schemas, content-addressed evidence/goldens, and a repository-local `current` pointer to the reviewed manifest. [ASSUMED] |
| Open question | Which exact upstream release/commit combination passes a complete local `create → init → skills → build → verify → Chromium → dry-run` fixture; the present registry/source split prevents preselecting one. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source; VERIFIED: npm registry] |
| Deferred concern | Production signing, deployment side effects, preview shell, worker isolation and secret delivery belong to later phases; Phase 1 permits only dry-run manifest construction. [VERIFIED: 01-CONTEXT.md] |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|---|---|---|---|
| NIP-5D artifact semantics | Build/verifier | Browser shell | The verifier proves the sealed bytes and manifest; a shell later enforces runtime sandbox and message-source identity. [CITED: https://github.com/nostr-protocol/nips/pull/2303] |
| Scaffold/skills workflow | Build/verifier | Agent workspace (later) | Phase 1 proves the toolchain path without building the production agent. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source] |
| Aggregate-hash and golden comparison | Build/verifier | Immutable artifact storage | The Vite/CLI tooling computes hashes; CVM promotion policy decides whether they match the reviewed golden. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source] |
| Chromium/reference-shell conformance | Build/verifier | Browser | The upstream CLI launches Chromium and attaches the upstream reference shell. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source] |
| Candidate/promotion/quarantine state | Control plane | Immutable artifact storage | Only reviewed evidence changes the promoted pointer; candidates must not affect production. [ASSUMED] |
| Dry-run deploy contract | Build/verifier | CLI | The upstream CLI produces the normal deploy plan/manifests but omits network writes in dry-run mode. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source] |

## Standard Stack

### Core

| Library/tool | Version | Purpose | Why Standard |
|---|---:|---|---|
| TypeScript executed by Bun | Bun `1.2+`, image-pinned | Promotion runner, schemas, fixture controller, tests. | Project stack decision; current machine has Bun `1.2.1`. [VERIFIED: `.planning/research/STACK.md`; VERIFIED: local environment] |
| `@napplet/cli` [WARNING: flagged as suspicious — verify before using.] | **Do not select npm `0.0.0`**; pin reviewed executable commit and SHA-256 | Authoritative create/init/skills/deploy contract. | Its upstream source owns these commands, but npm provenance/version is inconsistent. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source; VERIFIED: npm registry] |
| `@napplet/boilerplate` [WARNING: flagged as suspicious — verify before using.] | candidate `0.3.1`, exact integrity required | Authoritative starter substrate behind `napplet create`. | The upstream docs define it as the maintained starter. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source] |
| `@napplet/skills` [WARNING: flagged as suspicious — verify before using.] | candidate `0.3.1`, exact integrity required | Installed authoring contract. | It prescribes scaffold preservation, SDK use, and `verify`/conformance workflow. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source] |
| `@napplet/sdk` [WARNING: flagged as suspicious — verify before using.] | candidate `0.27.2`, exact integrity required | Generated fixture’s shell-mediated NAP API. | The official napplet site describes it as the typed wrapper for `window.napplet`; use it rather than direct authority primitives. [CITED: https://napplet.run/] |
| `@napplet/vite-plugin` [WARNING: flagged as suspicious — verify before using.] | candidate `0.14.1`, exact integrity required | NIP-5A path/aggregate hash and manifest-sidecar build output. | It computes per-file SHA-256 and aggregate hash at build time. [CITED: https://napplet.run/docs/packages/vite-plugin.html] |
| `@napplet/conformance-cli` [WARNING: flagged as suspicious — verify before using.] | candidate `0.2.18`, exact integrity required | Native real-Chromium, reference-shell conformance gate. | It runs a Playwright browser against `sandbox="allow-scripts"` and exits nonzero on errors. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source] |

### Supporting

| Tool | Version | Purpose | When to Use |
|---|---:|---|---|
| pnpm | Corepack/image-pinned | Frozen dependency installation. | Materialize the candidate image once; use `--frozen-lockfile` and an approved offline store for all sealed fixture runs. [ASSUMED] |
| Playwright Chromium | exact browser revision from promoted image | Browser implementation used by the upstream conformance CLI. | Image build/preflight only; record browser version in evidence. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source] |
| Git + SHA-256 | image-pinned | Resolve exact spec/scaffold/NAP revisions and package/executable integrity. | Candidate intake and evidence verification. [ASSUMED] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|---|---|---|
| Native napplet manifest/conformance tooling | Custom NIP-5D validator or compatibility shim | Forbidden by D-01/D-08; it would create an implementation-specific contract and duplicate upstream ownership. [VERIFIED: 01-CONTEXT.md] |
| Frozen image-local commands | `npx` on every CI/build run | The upstream CLI defaults to `npx`, which can resolve packages during the run; this conflicts with a sealed, no-network build. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source] |
| Content-addressed reviewed goldens | Auto-updated snapshots | Auto-update would violate D-13 by treating changed bytes as proof rather than review input. [VERIFIED: 01-CONTEXT.md] |

**Installation:** Do not use a floating installation command. Candidate intake must produce a lockfile plus package tarball integrity and an image digest; the promotion fixture then installs only from that sealed material. [ASSUMED]

## Package Legitimacy Audit

| Package | Registry | Age on 2026-08-03 | Downloads | Source Repo | Verdict | Disposition |
|---|---|---:|---:|---|---|---|
| `@napplet/skills` | npm | 1 day | 503/wk | `github.com/napplet/napplet` | SUS | Flagged — human verifies publisher, tarball integrity, and upstream commit before image intake. |
| `@napplet/boilerplate` | npm | 8 days | 161/wk | `github.com/napplet/napplet` | SUS | Flagged — human verifies publisher, tarball integrity, and upstream commit before image intake. |
| `@napplet/sdk` | npm | 1 day | 791/wk | `github.com/sandwichfarm/napplet` | SUS | Flagged — human verifies publisher, tarball integrity, and upstream commit before image intake. |
| `@napplet/vite-plugin` | npm | 1 day | 593/wk | `github.com/sandwichfarm/napplet` | SUS | Flagged — human verifies publisher, tarball integrity, and upstream commit before image intake. |
| `@napplet/conformance-cli` | npm | 6 days | 348/wk | `github.com/sandwichfarm/napplet` | SUS | Flagged — human verifies publisher, tarball integrity, and upstream commit before image intake. |
| `@napplet/cli` | npm | 27 days | 6/wk | `github.com/sandwichfarm/napplet` | SUS | Do not install the `0.0.0` registry package as the promoted CLI; resolve and review the official standalone executable/source release instead. |

**Packages removed due to [SLOP] verdict:** none.

**Packages flagged as suspicious [SUS]:** all listed packages. The planner must include `checkpoint:human-verify` before candidate image intake. [VERIFIED: package-legitimacy seam; VERIFIED: npm registry]

## Architecture Patterns

### System Architecture Diagram

```text
candidate detector ──> candidate manifest (spec/NAP/package/image pins)
                              │
                              v
                      sealed build image, no network/secrets
                              │
                              v
  minimal + synthetic + hostile fixtures ──> native CLI/skills/build commands
                              │                         │
                              │                         ├─> upstream unit/manifest/CLI suites
                              │                         ├─> pnpm verify
                              │                         ├─> Chromium reference-shell conformance
                              │                         └─> CLI dry-run manifests only
                              v
             independent CVM policy gaps + two-clean-build reproducibility
                              │
                     ┌────────┴────────┐
                     v                 v
             quarantine evidence    reviewed golden match
                                       │
                                       v
                         immutable promotion bundle + explicit review
                                       │
                         current promoted-set pointer OR rejected candidate
```

The runner consumes only a candidate promotion manifest, fixture sources, and image-local binaries. It writes a result bundle; production reads only the reviewed promoted-set pointer. A failed or unreviewed candidate has no production path. [ASSUMED]

### Recommended Project Structure

```text
src/
├── promotion/              # candidate manifest, schema, state transitions, explicit promotion/rollback
├── evidence/               # deterministic report index, content-addressed bundle and golden references
├── policy/                 # narrow artifact-scope gaps; never NIP/NAP validator replacement
├── runner/                 # hermetic subprocess limits, environment scrub and native-command adapter
└── fixtures/               # fixture registration and expected positive/negative results
fixtures/
├── minimal/                # smallest valid focused napplet
├── capability-harness/     # representative storage + resource + one social/intent NAP composition
└── hostile/                # source and post-build mutations only for uncovered checks
goldens/                    # reviewed content-addressed unsigned dist trees + expected aggregate hashes
toolchains/                 # reviewed promotion manifests; `current.json` points to one immutable manifest
tests/                      # promotion state, schemas, policy-gap tests and fixture orchestration
```

### Pattern 1: Promote an immutable compatibility set, never individual packages

**What:** A toolchain ID is the canonical serialization of: NIP-5D PR/head SHA; each applicable NAP SHA; CLI executable SHA/version; package names, versions, tarball integrity and repository commit; scaffold commit; lockfile digest; Bun/Deno/pnpm versions; Chromium/Playwright revision; image digest; fixture/golden revisions; and verifier policy version. [ASSUMED]

**When to use:** Every candidate detection, test, promotion, rollback, artifact evidence, and later checkpoint must refer to this opaque ID rather than “latest napplet.” [ASSUMED]

**Example:**

```ts
type PromotionManifest = Readonly<{
  id: string;                 // digest of canonical JSON excluding approvals
  nip5dCommit: string;
  napCommits: Record<string, string>;
  imageDigest: string;
  runtime: { bun: string; chromium: string; pnpm: string };
  inputs: Array<{ name: string; version: string; integrity: string; sourceCommit: string }>;
  scaffoldCommit: string;
  lockfileSha256: string;
  verifierPolicyVersion: string;
}>;
```

### Pattern 2: Two clean unsigned builds, then separately produced deploy metadata

**What:** Build the same fixture twice in isolated fresh work directories with the same manifest and deterministic environment. Hash every served `dist` file and compare bytes plus aggregate hash to each other and to the immutable golden. Produce `napplet deploy --dry-run` only after this passes; its timestamped/signed output is evidence, never part of `dist`. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source; VERIFIED: 01-CONTEXT.md]

**When to use:** Every candidate promotion and every deliberate golden update. [ASSUMED]

### Pattern 3: Narrow policy-gap tests around upstream ownership

**What:** Keep the upstream `scanForbiddenGlobals`, manifest validator, reference shell, and conformance CLI intact. Add CVM tests only for policy facts not covered by the current upstream scan: service-worker registration, dynamic code/authority construction, direct signer/relay library imports or obvious direct protocol clients, and mutations of built output after a passing build. Do not add a second envelope or manifest parser. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source]

**When to use:** Only after an upstream coverage inventory identifies the gap; remove the CVM check if upstream adopts the identical assertion, then retain a regression invocation of the upstream suite. [ASSUMED]

### Pattern 4: Waiver is an auditable temporary exception, not a bypass channel

**What:** Default state is `blocked`. A waiver record must bind the exact toolchain ID, failing check ID/report digest, human owner identity, reason, compensating evidence, explicit expiry, rollback trigger, and immutable authorization record; the runner verifies all fields before changing the candidate to `waived`. [ASSUMED]

**Non-waivable classes:** invalid/missing pinned provenance; NIP-5D/NIP-5A or required NAP semantic violation; direct-authority or sandbox violation; aggregate-hash/golden/byte reproducibility mismatch; evidence integrity failure; or any actual network/secrets access in the sealed run. These failures invalidate the claim that the artifact is safe or reproducible, so a waiver would contradict D-01, D-10, D-14, and SAFE-05/06. [ASSUMED]

**Waivable classes:** only a demonstrably external/flaky execution failure after a successful equivalent run for the same immutable candidate, or an upstream non-security diagnostic defect with a linked upstream issue and compensating successful evidence. The expiration must be short and the rollback trigger automatic at expiry or on any affected failure. [ASSUMED]

### Anti-Patterns to Avoid

- **Compatibility shim:** Never adjust a manifest/envelope so a broken upstream package appears to conform; file and test an upstream correction instead. [VERIFIED: 01-CONTEXT.md]
- **Auto-promoting changed bytes:** A new build passing tests cannot overwrite a golden or `current` pointer. [VERIFIED: 01-CONTEXT.md]
- **Using `npx` in the sealed run:** It is the CLI default for conformance but allows run-time dependency resolution; override the command to the image-local binary. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source]
- **Treating a regex scan as complete containment:** The current upstream scanner declares itself heuristic and does not list service workers or every dynamic form; retain runtime Chromium checks and targeted gap cases. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source]
- **Dry-running with a real user key:** Phase 1 needs only synthetic test signing material; user custody/publishing is explicitly later work. [ASSUMED]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| NIP-5D/NAP envelope and manifest validation | CVM parser or validator | Upstream `@napplet/conformance` and conformance CLI | Native suite is the implementation-layer coverage and must stay in lockstep with upstream NAPs. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source] |
| Browser shell/reference responses | A bespoke mock shell | Upstream reference shell through the conformance CLI | It tests actual postMessage behavior in Chromium and degraded capability handling. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source] |
| Manifest/path/aggregate hashing | CVM hash/manifest emitter | Upstream Vite plugin and CLI dry-run | NIP-5A tags, hashes, and deploy templates have protocol edge cases and upstream ownership. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source] |
| Scaffolding/skills installation | Custom starter or copied skill text | Promoted `napplet create`, `napplet init`, `napplet skills install` | Ensures fixture uses the intended maintained substrate. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source] |
| Release approval/evidence indexing | Manual CI log interpretation | Small CVM promotion state/evidence layer | This product-specific review, quarantine, golden, and waiver record is not owned upstream. [ASSUMED] |

**Key insight:** Phase 1 is a composition and promotion problem, not a new napplet protocol implementation. The CVM must verify provenance and execution boundaries around upstream tools while leaving NIP/NAP semantics upstream. [VERIFIED: 01-CONTEXT.md]

## Common Pitfalls

### Pitfall 1: Pinning versions without pinning the source identity

**What goes wrong:** npm `@napplet/cli` reports `0.0.0` while the sibling implementation reports `0.5.0`, and package repositories differ. A semver pin alone can select the wrong executable. [VERIFIED: npm registry; VERIFIED: sibling `/Users/sandwich/Develop/napplet` source]

**How to avoid:** Require registry integrity, reviewed source commit, executable SHA-256, lockfile digest, and image digest in the candidate manifest; a missing field blocks promotion. [ASSUMED]

### Pitfall 2: Calling the CLI’s default conformance command in a no-network build

**What goes wrong:** The CLI default invokes `npx --yes @napplet/conformance-cli`; a build can drift or attempt network resolution. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source]

**How to avoid:** Configure `conformance.command` to a preinstalled image-local `napplet-conformance` path and make egress denial observable. [ASSUMED]

### Pitfall 3: Comparing signed manifests rather than unsigned artifact bytes

**What goes wrong:** Manifest creation includes time and possibly signatures; equal source may have different metadata even when `dist` is identical. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source]

**How to avoid:** Compare the complete unsigned served `dist` byte tree and aggregate hash first; retain dry-run manifest/signature data as a separate evidence object. [VERIFIED: 01-CONTEXT.md]

### Pitfall 4: Assuming the current static scanner covers SAFE-06 completely

**What goes wrong:** The current scanner covers direct fetch/XHR/WebSocket, browser storage/cookies, `window.nostr`, and explicit external script/style/image URLs, but is documented as heuristic and does not list service-worker registration or dynamic access forms. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source]

**How to avoid:** First record the upstream scanner result; then test the narrow missing cases at source and post-build levels and fail closed on dynamic code construction that prevents inspection. [ASSUMED]

### Pitfall 5: Letting a waiver change the artifact contract

**What goes wrong:** A generic “override” turns a known direct-authority or reproducibility failure into production input. [ASSUMED]

**How to avoid:** Enforce the non-waivable list in code, bind the waiver to exactly one immutable toolchain and failure, and have expiry roll the set back to blocked without a new review. [ASSUMED]

## Code Examples

### Promotion gate sequence

```ts
// CVM-owned orchestration; each command is image-local and version-checked.
await runNativeSuites(toolchain);            // unchanged upstream suite commands
const first = await buildUnsignedFixture(toolchain, fixture);
const second = await buildUnsignedFixture(toolchain, fixture);

assertSameBytes(first.distTree, second.distTree);
assert.equal(first.aggregateHash, second.aggregateHash);
assertGolden(first, fixture.golden);
await runImageLocalConformance(first.distDir, { reporter: 'json' });
await runCvmPolicyGaps(first, fixture);      // only uncovered SAFE-06 assertions
await runCliDryRun(first.distDir, toolchain); // no upload/publish
```

This deliberately consumes native reports rather than importing private upstream validators. [ASSUMED]

### Fixture matrix

| Fixture | Must prove | Must not become |
|---|---|---|
| `minimal` | Scaffold, one purpose, zero or one hard NAP requirement, stable unsigned `dist`. | A product demo. [ASSUMED] |
| `capability-harness` | SDK-mediated envelopes and one representative state/resource plus one intent/social NAP path; primary and degraded reference-shell pass. | A second conformance engine. [VERIFIED: 01-CONTEXT.md] |
| `hostile` | Each uncovered source/mutation is rejected: service worker, forbidden direct authority, external asset, full-stack/backend signature, aggregate hash mutation. | A broad custom NIP validator. [ASSUMED] |

## State of the Art

| Old/unsafe approach | Current required approach | Impact |
|---|---|---|
| Raw Vite page/direct Nostr/browser APIs | Opaque-origin NIP-5D napplet using typed shell-mediated NAPs. | Signer, storage, and relay authority remain with the shell. [CITED: https://github.com/nostr-protocol/nips/pull/2303] |
| “Latest” package and local successful build | Explicit compatibility-set promotion with reproducibility and browser evidence. | Prevents unreviewed protocol/package changes from becoming production semantics. [VERIFIED: 01-CONTEXT.md] |
| One browser smoke test | Native upstream unit/manifest/CLI/reference-shell suites plus a real-Chromium conformance run and thin composition fixtures. | Separates upstream protocol coverage from CVM integration ownership. [VERIFIED: 01-CONTEXT.md] |

**Deprecated/outdated:** Treating NIP-5D as stable is incorrect; the official PR is open and has active security/terminology discussion, so every promoted set must name an exact revision. [CITED: https://github.com/nostr-protocol/nips/pull/2303]

## Open Questions

1. **Which upstream CLI distribution is authoritative for the first promoted set?**
   - What we know: Official source describes a `0.5.0` CLI, while npm exposes `@napplet/cli@0.0.0`; the official installer documents SHA256SUMS verification. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source; VERIFIED: npm registry]
   - What's unclear: The reviewed release asset/source commit/tarball mapping that composes with the npm package set.
   - Recommendation: Make this the first `checkpoint:human-verify`; do not plan a claimed production CLI version before the full fixture passes.

2. **What exact NAP revisions/domains should the synthetic harness cover?**
   - What we know: NIP-5D delegates domain messages to NAPs, and capabilities are manifest requirements. [CITED: https://github.com/nostr-protocol/nips/pull/2303]
   - What's unclear: Which NAP commits coexist with the first passing package set.
   - Recommendation: Pin at least one state/resource path and one intent/social path from the same reviewed NAP revision set; keep each hard requirement demonstrably necessary. [ASSUMED]

3. **Can the promoted scaffold yield byte-identical unsigned output without a toolchain patch?**
   - What we know: The Vite/CLI path computes aggregate hashes and manifests can carry time/signature data. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source]
   - What's unclear: Whether bundle contents contain timestamp/build-path nondeterminism under the frozen image.
   - Recommendation: Treat the two-clean-build test as a promotion blocker; upstream fixes, not CVM shims, resolve any toolchain nondeterminism.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---|---|---|
| Bun | CVM promotion harness | ✓ | `1.2.1` | — |
| Node | package metadata/probe tools | ✓ | `v25.2.1` | — |
| npm | candidate registry verification | ✓ | `11.6.2` | — |
| pnpm | frozen fixture install | ✓ | `10.24.0` | — |
| Playwright CLI | local inspection only | ✓ | `1.62.1` | Promoted image must still pin a browser revision. |
| Context7 CLI | preferred documentation lookup | ✗ | — | Official napplet docs, current NIP PR, sibling upstream source were inspected. |

**Missing dependencies with no fallback:** none for planning. The actual promoted CLI binary/source identity is an acceptance gate, not currently established. [VERIFIED: local environment; VERIFIED: sibling `/Users/sandwich/Develop/napplet` source]

## Validation Architecture

### Test Framework

| Property | Value |
|---|---|
| Framework | Bun test for CVM runner/policy/evidence unit tests; upstream suites are invoked unchanged. [ASSUMED] |
| Config file | none yet — Wave 0 creates `package.json`, `tsconfig.json`, and test scripts. [VERIFIED: workspace inspection] |
| Quick run command | `bun test` plus a minimal fixture native verification run. [ASSUMED] |
| Full suite command | `bun test && <upstream-native-suites> && <all-fixture-promotion-run>` in the sealed image. [ASSUMED] |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|---|---|---|---|---|
| GEN-01 | Only promoted CLI/scaffold/skills create the fixture. | integration | promotion runner against `fixtures/minimal` | ❌ Wave 0 |
| GEN-02 | Arbitrary/full-stack/backend request shapes reject. | unit + fixture | `bun test policy/scope` | ❌ Wave 0 |
| GEN-03 | SDK/NAP envelope use and minimal `requires`; degraded run works. | Chromium integration | `napplet-conformance --reporter json` for `capability-harness` | ❌ Wave 0 |
| GEN-04 | Native verification/conformance pass; two builds and golden hashes match. | integration | full promotion command | ❌ Wave 0 |
| SAFE-05 | Frozen/offline/no-secret/no-egress process policy. | integration | sealed-image promotion command with denial audit | ❌ Wave 0 |
| SAFE-06 | Direct authority/source and built mutations reject. | unit + Chromium integration | `bun test policy` and hostile fixture loop | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `bun test` plus the fixture subset changed by the task. [ASSUMED]
- **Per wave merge:** native upstream suite invocation and minimal fixture sealed run. [ASSUMED]
- **Phase gate:** all three fixtures, two-clean-build byte comparison, golden review, native package suites, JSON Chromium reports, provenance audit, and explicit promotion decision must be green. [ASSUMED]

### Wave 0 Gaps

- [ ] Root TypeScript/Bun test harness and schema validation.
- [ ] Candidate/promotion/waiver state model and content-addressed evidence writer.
- [ ] Minimal, capability-harness, and hostile fixture directories with reviewed expected results.
- [ ] Sealed image build that preinstalls packages/browser and disables run-time registry access.
- [ ] First human-verified CLI/source/package provenance checkpoint.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---|---|---|
| V2 Authentication | no | No user-facing auth is built in Phase 1; owner approval identity is recorded only for promotion governance. [ASSUMED] |
| V3 Session Management | no | No production session exists yet. [ASSUMED] |
| V4 Access Control | yes | Only the explicit reviewed promotion record may update `current`; candidates/quarantine have no production read path. [ASSUMED] |
| V5 Input Validation | yes | Canonical JSON schemas for candidate manifests, evidence, report digests, and waiver records; reject missing/extra provenance. [ASSUMED] |
| V6 Cryptography | yes | Use SHA-256 identities supplied by NIP-5A/tooling; do not implement a custom hash/signature scheme. [CITED: https://github.com/nostr-protocol/nips/pull/2303] |
| V10 Malicious Code | yes | Treat generated code/build output/dependencies as untrusted: frozen material, no secrets/egress, native browser conformance, and targeted authority checks. [ASSUMED] |

OWASP ASVS is the appropriate verification catalogue for application security; this phase applies only the categories that map to promotion inputs and authorization, not later account/session controls. [CITED: https://owasp.org/www-project-application-security-verification-standard/]

### Known Threat Patterns for the stack

| Pattern | STRIDE | Standard Mitigation |
|---|---|---|
| Package/source substitution | Tampering | Publisher + tarball integrity + source commit + executable/image digest must agree before intake. [ASSUMED] |
| Build script dependency reaches registry/network | Information disclosure / tampering | Prebuilt sealed image, frozen offline install, default-deny egress, and command allowlist; capture attempted egress as a failure. [ASSUMED] |
| Generated code bypasses NAP authority | Elevation of privilege | Upstream conformance/reference-shell and narrow gap fixtures reject direct primitives, external bytes, service workers, and dynamic/uninspectable authority. [VERIFIED: sibling `/Users/sandwich/Develop/napplet` source] |
| Artifact/manifest TOCTOU | Tampering | Compute and compare all `dist` bytes plus aggregate hash before evidence and dry-run; never allow dry-run metadata to alter `dist`. [VERIFIED: 01-CONTEXT.md] |
| Emergency waiver persists indefinitely | Elevation of privilege | Exact-candidate waiver, owner identity, immutable evidence, enforced expiry, and automatic rollback/blocked state. [ASSUMED] |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|---|---|---|
| A1 | Bun test is the smallest suitable CVM harness for this greenfield TypeScript phase. | Standard Stack / Validation | Planner may need to adopt existing project tooling once created. |
| A2 | An offline image-local pnpm store is feasible for every promoted fixture. | Standard Stack / SAFE-05 | Candidate setup must use an alternative hermetic package-cache strategy. |
| A3 | The selected capability harness can safely combine one state/resource path with one intent/social NAP path. | Fixtures | Harness may need a different pair based on accepted NAP revisions. |
| A4 | The recommended waiver mechanics are sufficient for Phase 1 governance. | Pattern 4 | Owner authorization/retention requirements may need product/security approval. |
| A5 | CVM policy gaps should reject dynamic code construction rather than attempt full static deobfuscation. | Pitfall 4 | Could reject otherwise valid generated output; safe fail-closed behavior must be accepted. |

## Sources

### Primary (official/upstream source)

- [NIP-5D PR #2303](https://github.com/nostr-protocol/nips/pull/2303) — current normative sandbox, source-identity, envelope, NAP negotiation, and NIP-5A linkage; PR is open.
- [napplet official site](https://napplet.run/) — package roles and stated alpha status.
- [Vite plugin documentation](https://napplet.run/docs/packages/vite-plugin.html) — path/aggregate hash and build-time manifest behavior.
- [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) — security verification categorization.
- Sibling checkout `/Users/sandwich/Develop/napplet` — inspected CLI, skills, boilerplate, Vite plugin, conformance runner, validators, reference shell, and deployment-network test source.

### Secondary (registry/tool evidence)

- npm registry inspected 2026-08-03 — current versions/times and repository metadata for all proposed `@napplet/*` packages.
- Package-legitimacy seam inspected 2026-08-03 — every proposed package returned `SUS`; no postinstall value was returned by npm metadata.

## Metadata

**Confidence breakdown:**

- Standard stack: MEDIUM — official/sibling behavior was inspected, but every npm candidate is newly published and flagged SUS.
- Architecture: MEDIUM — directly follows locked decisions and inspected upstream seams; promotion-state implementation is new CVM work.
- Pitfalls: HIGH for the CLI `npx` default and current heuristic static scanner; MEDIUM for the proposed sealed-image and waiver implementation.

**Research date:** 2026-08-03
**Valid until:** 2026-08-10 — NIP-5D and napplet packages are active alpha work; re-check before implementation.
