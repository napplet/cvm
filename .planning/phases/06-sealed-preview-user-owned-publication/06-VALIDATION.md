---
phase: 06-sealed-preview-user-owned-publication
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-05
updated: 2026-08-05
---

# Phase 6 — Validation Strategy

> Nyquist contract for sealed preview, owner-held signing, exact-byte publication, and original-operation reconciliation. This remains `draft` until execution creates every named test/fake/evidence surface and the final Phase 6 gate passes.

## Validation principle

Every behavior-changing task creates its named test/fake surface before production implementation and observes a focused failure first. Deterministic host, signer-return, promoted-CLI-source, Blossom, relay, attestation, clock, and SQL fakes are authoritative for this design slice. Live host, external signer, standalone CLI asset, relay, Blossom, PostgreSQL/Cockroach, and provider execution remain explicit `not_observed` facts for Phase 7.

Exact comparisons use bytes, canonical UTF-8 strings, SHA-256 values, and integer timestamps. No rounding, tolerance, approximate matcher, rebuild, re-sign, redeploy, or replacement effect is permitted.

## Wave 0 test/fake/evidence ownership

| ID | Plan/task | Surface created before dependent implementation | Requirements | Initial proof command | File exists |
|---|---|---|---|---|---|
| 06-W0-01 | 06-01-01 | `tests/phase-06/tracer.test.ts` with local deterministic ports | PREV-01..04, PUB-01..05 | `bun test tests/phase-06/tracer.test.ts --timeout 10000` | ❌ |
| 06-W0-02 | 06-02-01 | `tests/phase-06/fakes.ts`, `preview-descriptor.test.ts` | PREV-01 | `bun test tests/phase-06/preview-descriptor.test.ts --timeout 10000` | ❌ |
| 06-W0-03 | 06-02-01 | `runtime-status.test.ts` | PREV-02 | `bun test tests/phase-06/runtime-status.test.ts --timeout 10000` | ❌ |
| 06-W0-04 | 06-02-02 | `capability-review.test.ts` | PREV-03, PREV-04 | `bun test tests/phase-06/capability-review.test.ts --timeout 10000` | ❌ |
| 06-W0-05 | 06-03-01 | `publication-intent.test.ts` | PUB-01 | `bun test tests/phase-06/publication-intent.test.ts --timeout 10000` | ❌ |
| 06-W0-06 | 06-03-02 | `nostr-tools-direct-dependency.test.ts` | PUB-03 | `bun test tests/phase-06/nostr-tools-direct-dependency.test.ts --timeout 10000` | ❌ |
| 06-W0-07 | 06-03-03 | `manifest-signature.test.ts` | PUB-02, PUB-03 | `bun test tests/phase-06/manifest-signature.test.ts --timeout 10000` | ❌ |
| 06-W0-08 | 06-04-01 / 06-04-02 | `publication-store-parity.test.ts` | PUB-01, PUB-05 | `bun test tests/phase-06/publication-store-parity.test.ts --timeout 10000` | ❌ |
| 06-W0-09 | 06-05-01 | `src/publication/napplet-cli-source-contract.ts`, `scripts/probe-phase-06-cli-source-contract.ts`, `tests/fixtures/phase-06-cli-source-contract.json`, `tests/phase-06/cli-source-contract.test.ts` | PUB-04 | `bun test tests/phase-06/cli-source-contract.test.ts --timeout 10000 && bun run scripts/probe-phase-06-cli-source-contract.ts` | ❌ |
| 06-W0-10 | 06-05-02 | `sealed-deployment.test.ts` plus deterministic promoted-source fake gated by the exact-source result | PUB-04 | `bun test tests/phase-06/sealed-deployment.test.ts --timeout 10000` | ❌ |
| 06-W0-11 | 06-05-03 | `publication-reconciliation.test.ts` | PUB-05 | `bun test tests/phase-06/publication-reconciliation.test.ts --timeout 10000` | ❌ |
| 06-W0-12 | 06-06-01 | `tests/contextvm/publication-adapter.test.ts` including unavailable-probe announcement/effect cases | PREV-01..04, PUB-01..05 | `bun test tests/contextvm/publication-adapter.test.ts --timeout 10000` | ❌ |
| 06-W0-13 | 06-06-02 | `host-surface.test.ts` | PREV-01..04, PUB-01..05 | `bun test tests/phase-06/host-surface.test.ts --timeout 10000` | ❌ |
| 06-W0-14 | 06-07-01 | `tests/fixtures/phase-06-reference-set.json`, `tests/evals/phase-06-reference-set.test.ts` | PREV-01..04, PUB-01..05 | `bun test tests/evals/phase-06-reference-set.test.ts --timeout 10000` | ❌ |
| 06-W0-15 | 06-07-02 | `src/verification/phase-06-design-evidence.ts`, `scripts/verify-phase-06-design-slice.ts` | PREV-01..04, PUB-01..05 | `bun run verify:phase06-design` | ❌ |

## Per-plan verification map

| Plan | Focused automated gate | What it proves |
|---|---|---|
| 06-01 | `bun test tests/phase-06/tracer.test.ts --timeout 10000` | One exact artifact-to-linked-publication vertical path and persist-before-effect ordering. |
| 06-02 | `bun test tests/phase-06/preview-descriptor.test.ts tests/phase-06/runtime-status.test.ts tests/phase-06/capability-review.test.ts --timeout 10000` | Sealed descriptor/grant, finite runtime state, required/optional capability semantics, canonical digest. |
| 06-03 | `bun test tests/phase-06/nostr-tools-direct-dependency.test.ts tests/phase-06/publication-intent.test.ts tests/phase-06/manifest-signature.test.ts --timeout 10000` | Exact direct pure-verification dependency, intent identity/expiry/replay, external signing custody, NIP-01 and semantic verification, distinct attestation. |
| 06-04 | `bun test tests/phase-06/publication-store-parity.test.ts tests/persistence/phase-05-sql-schema-parity.test.ts --timeout 10000` | Memory/SQLite/PostgreSQL-style transaction parity, concurrency, restart, original operation identities. |
| 06-05 | `bun test tests/phase-06/cli-source-contract.test.ts tests/phase-06/sealed-deployment.test.ts tests/phase-06/publication-reconciliation.test.ts --timeout 10000 && bun run scripts/probe-phase-06-cli-source-contract.ts` | Exact promoted identity/source route, fail-closed publication availability, exact sealed bytes/event, failure/timeout/partial, lookup-only reconciliation. |
| 06-06 | `bun test tests/contextvm/publication-adapter.test.ts tests/phase-06/host-surface.test.ts --timeout 10000` | Signed owner actions, safe notifications, no preview/top-up effect, and every covered UI consideration. |
| 06-07 | `bun run verify:phase06-design` | Actual-authority reference set, full mappings/API gate, content-address integrity, redaction, honest live observations. |

## Requirement coverage

| Requirement | Primary tests | Reference/evidence gate |
|---|---|---|
| PREV-01 | tracer, preview descriptor, ContextVM adapter | P06-TRACE-01; P06-PREV-EMPTY/NULL; phase-06 evidence mapping |
| PREV-02 | runtime status, host surface | ready/incompatible/expired/denied and runtime-message taint cases |
| PREV-03 | capability review, host surface | empty/null/order/hash/zero-one-many cases |
| PREV-04 | capability review, publication intent, ContextVM adapter | required/optional and runtime-variant fence cases |
| PUB-01 | publication intent, persistence parity | expiry -1/exact/+1, replay/conflict/concurrency cases |
| PUB-02 | manifest signature, ContextVM adapter | no-secret completed-event handoff cases |
| PUB-03 | manifest signature | NIP-01 plus valid-signature/wrong-semantic cases |
| PUB-04 | sealed deployment | promoted identity, exact bytes/event, full-server/relay predicates |
| PUB-05 | persistence parity, reconciliation, host surface | interrupted/unknown/failure/timeout/partial/original-observe cases |

## Mandatory edge probes

The canonical E-01 through E-23 definitions and plan/task mappings live in `COVERAGE.md`. The reference set must execute all of them, including:

- empty and null artifacts;
- empty and null manifests;
- empty and null capability sets;
- stable capability ordering and canonical equality/hash behavior;
- expiry one millisecond before, exact, and one millisecond after;
- exact replay and conflicting duplicate;
- concurrent submit and interrupted unknown effect;
- reconciliation of original operations only;
- cryptographically valid signatures with wrong artifact, d-tag, capability digest, intent, or expiry bindings;
- promoted CLI source failure, timeout, and partial observations;
- all runtime variants preserving identical artifact/intent/capability-digest fences.

## API/package coverage gate

`COVERAGE.md` is canonical. `verify:phase06-design` must fail unless every relevant host, NIP-5D/NIP-5A/NIP-01, attestation, promoted CLI source, ContextVM, and effect capability has exactly one `INTEGRATE` or `OPT-OUT` decision with a reason and plan/task mapping. It must also fail if:

- npm `@napplet/cli@0.0.0` is installed, invoked, or treated as integrated;
- promoted standalone CLI 0.5.2 commit is not exactly `1a38b9150f3a3da148091c11bce4d0365f7298e5` or Linux SHA-256 is not exactly `46685f2e4df516b5b2e7e2e133480c90e5c85dbd36d05c6e95f4eee6af33ec5e`;
- the exact-source probe is missing/unavailable/mismatched while `publication` is announced available;
- the root manifest/lock does not declare and resolve exact direct `nostr-tools@2.24.1`, or production imports any non-`pure` verifier surface;
- a signing/key-management capability is reachable from production;
- a CLI workspace/build/manifest mutation path is reachable from publication;
- an INTEGRATE row lacks a direct test/source-facade/evidence mapping.

## Evidence honesty and redaction

The final evidence record must distinguish:

- `passed`: deterministic in-process service/store/adapter/port behavior actually executed by the verifier;
- `not_observed`: live host, external signer, promoted standalone CLI asset, relay, Blossom, PostgreSQL/Cockroach, and selected provider behavior not executed in Phase 6.

Evidence/status serialization must not contain user private keys, signer secrets, raw ContextVM envelopes, bearer credentials, protected evidence payloads, full provider/CLI output, or untrusted runtime messages. Public owner event ids/signatures may appear only where the owner-safe schema explicitly requires them.

## Phase gate

Run in order:

1. `bun test tests/phase-06/tracer.test.ts tests/phase-06/preview-descriptor.test.ts tests/phase-06/runtime-status.test.ts tests/phase-06/capability-review.test.ts --timeout 10000`
2. `bun test tests/phase-06/nostr-tools-direct-dependency.test.ts tests/phase-06/publication-intent.test.ts tests/phase-06/manifest-signature.test.ts tests/phase-06/publication-store-parity.test.ts --timeout 10000`
3. `bun test tests/phase-06/cli-source-contract.test.ts tests/phase-06/sealed-deployment.test.ts tests/phase-06/publication-reconciliation.test.ts tests/contextvm/publication-adapter.test.ts tests/phase-06/host-surface.test.ts --timeout 10000`
4. `bun run probe:phase06-cli-source`
5. `bun run eval:phase06`
6. `bun run verify:phase06-design`
7. Repeat `bun run verify:phase06-design` and require byte-identical pointer/content-address evidence.
8. `bun test --timeout 10000`

## Completion conditions

- All Wave 0 rows exist and their focused commands pass.
- The promoted source probe asserts the exact full commit/SHA and safe structured route; an unavailable result keeps publication announcement/actions unavailable with zero effects.
- All nine requirement mappings, D-96 through D-113 mappings, high-severity threat mappings, API capability dispositions, E-01 through E-23 mappings, and eight UI consideration mappings are nonempty.
- No product prohibition is violated: exact verified bytes only, no same-origin/direct authority, no user key custody, no effect recreation during reconciliation, no partial-as-complete, no preview/top-up publication effect.
- `evidence/design/phase-06.json` points to a hash-valid immutable record and repeated verification is deterministic.
- Live integrations remain explicitly `not_observed` until Phase 7 executes them.
