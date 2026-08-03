# Phase 1: Napplet Contract & Artifact Verification - Pattern Map

**Mapped:** 2026-08-03  
**Files analyzed:** 15 planned files/directories  
**Analogs found:** 8 / 15 (the remaining surfaces are deliberately CVM-owned; this repository is greenfield)

## Boundary Before Patterns

This phase composes public, promoted napplet commands and retains their reports. It must **not** copy/fork NIP-5D/NAP envelope validation, manifest validation, aggregate-hash generation, reference-shell behavior, or deployment networking.

- Invoke promoted image-local `napplet create`, `napplet init`, and `napplet skills install`; the upstream dispatcher currently delegates `create` and `skills` at [`packages/cli/src/cli.ts:84-87`](/Users/sandwich/Develop/napplet/packages/cli/src/cli.ts:84).
- Invoke promoted image-local `napplet-conformance <dist> --reporter json`; it serves a loopback harness, drives real Chromium, scans served files, builds a context, and reports the upstream result at [`packages/conformance-cli/src/cli.ts:249-305`](/Users/sandwich/Develop/napplet/packages/conformance-cli/src/cli.ts:249).
- Use `napplet deploy --dry-run --json` only after the sealed bytes pass; upstream dry-run produces manifest templates without `executeNetworkDeploy` at [`packages/cli/src/cli.ts:272-325`](/Users/sandwich/Develop/napplet/packages/cli/src/cli.ts:272).
- Keep CVM-owned code narrow: candidate/provenance schema, hermetic command invocation, fixture composition, byte/golden comparison, policy gaps proven absent upstream, evidence indexing, reviewed pointer/state, and waiver enforcement.

## File Classification

| New/Modified File | Role | Data flow | Closest analog / public seam | Match quality |
|---|---|---|---|---|
| `package.json`, `tsconfig.json` | config | batch | upstream package scripts/config | partial |
| `src/promotion/schema.ts` | model | transform | `packages/conformance/src/run/runner.ts` serializable result model | role-match |
| `src/promotion/service.ts` | service | batch | CLI deploy orchestration, `packages/cli/src/cli.ts` | flow-match |
| `src/promotion/state.ts` | store | event-driven | no upstream equivalent; CVM promotion ownership | none |
| `src/runner/hermetic-command.ts` | utility/service | request-response | `runPackageCli` / `runCommand` seams in `packages/cli/src/cli.ts` | partial |
| `src/evidence/bundle.ts` | utility | file-I/O | `ConformanceRun` serializable result | role-match |
| `src/evidence/golden.ts` | utility | file-I/O | CLI/Vite manifest file enumeration + hash ordering | flow-match |
| `src/policy/scope.ts` | utility | transform | `scanForbiddenGlobals` | partial, CVM gap-only |
| `src/policy/waiver.ts` | model/service | event-driven | no upstream equivalent; CVM governance ownership | none |
| `src/fixtures/registry.ts` | utility | batch | upstream conformance check catalog/runner | partial |
| `fixtures/minimal/` | fixture | batch | `@napplet/boilerplate` created project | exact public workflow |
| `fixtures/capability-harness/` | fixture | request-response | upstream reference shell + conformance CLI | exact public workflow |
| `fixtures/hostile/` | fixture | transform | upstream forbidden-global scan tests | role-match, gap-only |
| `goldens/<toolchain-id>/` | artifact data | file-I/O | Vite/CLI hash conventions | flow-match |
| `toolchains/*.json`, `toolchains/current.json` | config/state | event-driven | no upstream equivalent; CVM promotion ownership | none |
| `tests/promotion.test.ts`, `tests/policy.test.ts` | test | batch | CLI network test dependency-injection style | role-match |

## Pattern Assignments

### `src/promotion/service.ts` and `src/runner/hermetic-command.ts` (service/utility, batch)

**Analog:** public CLI orchestration in [`packages/cli/src/cli.ts:253-328`](/Users/sandwich/Develop/napplet/packages/cli/src/cli.ts:253).

Copy the orchestration shape—parse/construct a plan, invoke explicit dependencies, make the dry-run branch side-effect free, return a structured report, and clean up in `finally`—but do not import its private deployment implementation. The CVM runner must execute approved image-local binaries through argv arrays and a scrubbed environment, never shell text and never `npx`.

```ts
const dryRun = flags.boolean.has("dry-run");
const manifests = signer
  ? await signDeployManifestTemplates(await createDeployManifestTemplates(plan, config, { sourcePubkey: signer.pubkey }), signer)
  : await createDeployManifestTemplates(plan, config);
if (!dryRun) await executeNetworkDeploy(manifests, config, signer);
```

Upstream's `runPackageCli` deliberately uses argv arrays, but resolves `npx --yes` [`packages/cli/src/cli.ts:123-143`](/Users/sandwich/Develop/napplet/packages/cli/src/cli.ts:123). Preserve the argv-array safety property while replacing that resolution with a manifest-pinned absolute/image-local executable. Its default conformance resolution also falls back to `npx` [`packages/cli/src/cli.ts:146-159`](/Users/sandwich/Develop/napplet/packages/cli/src/cli.ts:146); require `conformance.command` to name the preinstalled binary instead.

**CVM sequence to implement:** native upstream suites → two fresh fixture builds → byte-tree/aggregate/golden assertions → image-local Chromium report → only proven policy gaps → dry-run JSON evidence. Any failure yields `blocked`/`quarantined`, never a compatibility shim or auto-promotion.

### `src/evidence/golden.ts` and `goldens/<toolchain-id>/` (utility/data, file-I/O)

**Analog:** [`packages/cli/src/manifest.ts:35-53`](/Users/sandwich/Develop/napplet/packages/cli/src/manifest.ts:35) and [`packages/vite-plugin/src/hashing.ts:28-47`](/Users/sandwich/Develop/napplet/packages/vite-plugin/src/hashing.ts:28).

The relevant upstream algorithm is sorted per-file SHA-256/path lines, then SHA-256 of their UTF-8 concatenation:

```ts
const lines = files.map((file) => `${file.sha256} ${file.path}\n`).sort();
return await sha256Text(lines.join(""));
```

Do **not** reimplement it as a second protocol emitter. Let the promoted build/plugin and CLI produce their aggregate values, then CVM records: complete unsigned served `dist` bytes, per-file digests, upstream aggregate hash, golden artifact digest, and a deterministic diff. The upstream plugin explicitly excludes `.nip5a-manifest.json` from its aggregate input [`packages/vite-plugin/src/manifest.ts:156-168`](/Users/sandwich/Develop/napplet/packages/vite-plugin/src/manifest.ts:156); signed/timestamped manifest/deploy data is separate evidence, never golden `dist` content.

### `src/fixtures/registry.ts`, `fixtures/minimal/`, and `fixtures/capability-harness/` (utility/fixtures, batch and request-response)

**Analog:** maintained scaffold/skills workflow in [`packages/boilerplate/src/index.ts:336-344`](/Users/sandwich/Develop/napplet/packages/boilerplate/src/index.ts:336) and reference shell in [`packages/conformance/src/shell/reference-shell.ts:60-81`](/Users/sandwich/Develop/napplet/packages/conformance/src/shell/reference-shell.ts:60).

The fixture creator must use only the promoted workflow:

```text
pnpm install
napplet init
napplet skills install --to codex
pnpm verify
napplet deploy --dry-run
```

Install semantics are upstream-owned: `install({ to: 'codex' })` writes `.codex/skills/<skill>/SKILL.md` [`packages/skills/src/index.ts:163-191`](/Users/sandwich/Develop/napplet/packages/skills/src/index.ts:163). Retain the emitted skill block/version/digest as evidence; do not copy its text into CVM.

The capability harness should use promoted `@napplet/sdk` and exactly the hard `requires` domains it exercises. Let the real conformance CLI run primary plus degraded capability passes. Its reference shell records envelopes and returns canonical responses through `createReferenceHandler` [`packages/conformance/src/shell/reference-shell.ts:60-81`](/Users/sandwich/Develop/napplet/packages/conformance/src/shell/reference-shell.ts:60); do not make a CVM mock shell.

### `src/policy/scope.ts` and `fixtures/hostile/` (utility/fixture, transform)

**Analog:** [`packages/conformance-cli/src/scan.ts:17-66`](/Users/sandwich/Develop/napplet/packages/conformance-cli/src/scan.ts:17).

Always retain the upstream scanner verdict. It already rejects direct Nostr globals, `fetch`, XHR, WebSocket, browser storage/cookies, and explicit external image/script/style URLs:

```ts
{ label: 'fetch', re: /\b(?:window\s*\.\s*|globalThis\s*\.\s*)?fetch\s*\(/ },
{ label: 'WebSocket', re: /\b(?:new\s+)?WebSocket\s*\(/ },
{ label: 'localStorage', re: /\b(?:window\s*\.\s*)?localStorage\b/ },
```

The CVM policy module must contain only inventoried gaps: service-worker registration; dynamic authority lookup/code construction that makes inspection impossible; obvious app-owned signer/relay imports; full-stack/backend shape; and post-build mutation of a passing `dist` tree. Each hostile case must name the missing upstream assertion. If upstream adds an equivalent assertion, remove the duplicate CVM check and keep invoking the upstream command. Never parse envelopes or manifests here.

### `src/promotion/schema.ts`, `src/promotion/state.ts`, `src/policy/waiver.ts`, and `toolchains/*.json` (model/store, transform/event-driven)

**Analog:** serializable, explicit verdict model in [`packages/conformance/src/run/runner.ts:19-55`](/Users/sandwich/Develop/napplet/packages/conformance/src/run/runner.ts:19); there is no upstream promotion-state equivalent.

Mirror the useful characteristics, not the protocol logic: fixed machine-readable IDs, serializable result records, a summary, and a final boolean/state derived from failures. `ConformanceRun` evaluates every check then sets `ok` only when error-severity failures are zero [`packages/conformance/src/run/runner.ts:75-111`](/Users/sandwich/Develop/napplet/packages/conformance/src/run/runner.ts:75).

CVM schemas must require a canonical immutable toolchain identity: NIP-5D/NAP commits; package versions/tarball integrity/source commits; CLI executable digest; scaffold and lockfile digests; image/runtime/Chromium versions; fixture/golden revisions; policy version. `current.json` is updated only by explicit reviewed promotion and points to one immutable manifest. Candidate, blocked, quarantined, promoted, rolled-back, and expired-waiver transitions should be exhaustively modeled and tested.

A waiver binds one toolchain ID + failing check/report digest + owner identity + rationale + compensating evidence + expiry + rollback trigger. Enforce non-waivable provenance, semantic, direct-authority/sandbox, byte/golden/aggregate, evidence-integrity, and sealed-run network/secret failures. This is CVM governance, not upstream behavior.

### Upstream manifest validation and conformance invocation (external seam, request-response)

**Use, do not copy:** [`packages/conformance/src/validators/manifest.ts:107-179`](/Users/sandwich/Develop/napplet/packages/conformance/src/validators/manifest.ts:107) and [`packages/conformance-cli/src/cli.ts:249-305`](/Users/sandwich/Develop/napplet/packages/conformance-cli/src/cli.ts:249).

`validateManifestEvent` owns manifest kind/d-tag/index hash/known bare NAP requirement semantics. The CLI combines the static scan, real browser boot collection, `buildContext`, `runConformance`, and selected report formatter. Record its JSON output as package-native evidence; do not import private validators to create a duplicate CVM assertion.

### CLI manifest/deploy dry-run and deployment-network tests (external seam, file-I/O/request-response)

**Use, do not copy:** [`packages/cli/src/manifest.ts:113-164`](/Users/sandwich/Develop/napplet/packages/cli/src/manifest.ts:113), [`packages/cli/src/cli.ts:253-325`](/Users/sandwich/Develop/napplet/packages/cli/src/cli.ts:253), and [`packages/cli/tests/deploy_network_test.ts:127-162`](/Users/sandwich/Develop/napplet/packages/cli/tests/deploy_network_test.ts:127).

The CLI owns manifest collection, aggregate calculation, dry-run plan/template output, signing, uploads, and relay publication. Phase 1 runs the upstream network test unchanged in its native suite and invokes only dry-run for the fixture. The native test proves the actual deploy behavior with injected `fetch`, `publish`, clock, and progress seams—e.g. expected `HEAD` then `PUT`, MIME/hash headers, and signed events—rather than something CVM should reproduce.

## Shared Patterns

### Structured reports and failure handling

Capture stdout, stderr, exit status, start/finish timestamps, command argv, working directory identity, and output digest for every native command. Follow upstream's explicit non-zero convention: conformance returns `0` conformant, `1` non-conformant, `2` usage/runtime error [`packages/conformance-cli/src/cli.ts:4-13`](/Users/sandwich/Develop/napplet/packages/conformance-cli/src/cli.ts:4). Promotion treats all non-zero/native report errors as blockers by default.

### Manifest, capability, and shell boundary

Manifest requirements remain upstream-owned bare-domain validation: values beginning `nap:` or `NAP-` fail, as do unknown domains [`packages/conformance/src/validators/manifest.ts:155-168`](/Users/sandwich/Develop/napplet/packages/conformance/src/validators/manifest.ts:155). CVM asserts only that the harness declares no unused hard capability; it delegates protocol correctness and degraded-shell behavior to the promoted conformance run.

### No-network sealed runner

The upstream CLI normally has network-capable permissions and runtime `npx` defaults. The CVM wrapper is therefore the compensating ownership point: preinstall exact binaries/browser in the reviewed image, disable runtime registry/network access, use an allowlisted argv runner with resource limits and scrubbed secrets, and make any attempted egress a failure. This wrapper must not relax native tool behavior or substitute validators.

## No Analog Found

| File/surface | Role | Data flow | Reason / planner instruction |
|---|---|---|---|
| Promotion pointer/state transitions | store | event-driven | Product-specific promotion/quarantine/rollback ownership. Keep small and schema-first. |
| Immutable evidence bundle/index | utility | file-I/O | Product-specific audit/evidence retention, composed from native reports. |
| Golden review gate | utility | file-I/O | Upstream generates hashes; CVM owns reviewed content-addressed acceptance and diff. |
| Waiver enforcement | policy/model | event-driven | Product-specific owner governance; do not make it a generic bypass. |
| Hermetic runner | service | request-response | Required to compensate for upstream `npx`/network defaults without altering upstream packages. |

## Metadata

**Analog search scope:** sibling `/Users/sandwich/Develop/napplet` packages `cli`, `boilerplate`, `skills`, `vite-plugin`, `conformance`, and `conformance-cli`  
**Files scanned:** 16 source/test files (five primary analog groups)  
**Pattern extraction date:** 2026-08-03

## PATTERN MAPPING COMPLETE

**Phase:** 1 - Napplet Contract & Artifact Verification  
**Files classified:** 15  
**Analogs found:** 8 / 15

### Coverage

- Files with exact public-workflow analog: 3
- Files with role/flow-match analog: 5
- CVM-owned files with no upstream analog: 5

### Key Patterns Identified

- Upstream tools own napplet semantics; CVM invokes and records them rather than copying validators.
- Artifact identity is a complete unsigned byte tree plus the upstream aggregate hash; manifests/signatures remain evidence outside `dist`.
- Promotion is an explicit, immutable state transition backed by hermetic execution, native reports, goldens, and default-blocking evidence.

### Ready for Planning

Pattern mapping complete. Planner can reference the upstream public seams and keep CVM implementation confined to promotion/evidence/policy gaps.
