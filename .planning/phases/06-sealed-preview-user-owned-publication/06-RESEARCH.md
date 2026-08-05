# Phase 6: Sealed Preview & User-Owned Publication - Research

**Researched:** 2026-08-05
**Domain:** Host-rendered NIP-5D preview, NIP-01 user-owned manifest verification, sealed-byte deployment, and reconciled provenance
**Confidence:** MEDIUM

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

### Preview Identity and Runtime Boundary

- **D-96:** Preview is a host-runtime operation, not a new CVM-served application shell. ContextVM returns an owner-scoped preview descriptor that a compatible napplet runtime consumes; the host creates the NIP-5D iframe with `sandbox="allow-scripts"` and never adds `allow-same-origin`.
- **D-97:** A preview descriptor binds account, session, verified artifact version, aggregate hash, exact sealed object generation/checksum, manifest/capability digest, validation-evidence identity, toolchain compatibility identity, and a short-lived single-artifact access grant. The grant cannot select different bytes or confer publication authority.
- **D-98:** Only an immutable artifact in the durable verified state is previewable. Failed, incomplete, stale, superseded, or hash-mismatched artifacts return diagnostics/status only; preview never rebuilds, repairs, mutates, or substitutes artifact bytes.
- **D-99:** The runtime verifies the descriptor and artifact identity before display and reports `ready`, `incompatible`, `expired`, or `denied` through a strict safe status contract. Runtime messages remain untrusted NAP traffic and cannot mutate session, billing, artifact, or publication authority.

### Capability Review and Consent

- **D-100:** Capability review is derived from the exact verified manifest and separates required from optional NAP capabilities, showing human-readable purpose/consent implications and the selected runtime's advertised compatibility before publication approval.
- **D-101:** A missing required capability yields an explicit incompatible result and blocks executable preview/publication for that runtime. A missing optional capability produces a declared graceful-degradation result. Neither case permits direct browser, signer, relay, storage, or network fallback.
- **D-102:** The user approves the exact capability-set digest as part of publication intent. Any artifact, manifest, d-tag, capability, runtime-compatibility, or policy change invalidates the prior intent/signature and requires a new explicit review; it never silently broadens consent.

### User-Owned Manifest Signing

- **D-103:** The CVM creates one canonical unsigned NIP-5D owning-manifest event template bound to the verified artifact hash, normalized d-tag, capability-set digest, owner public key, publication-intent ID, and expiry. The owning public key must equal the SDK-verified ContextVM principal.
- **D-104:** Signing occurs only through the trusted napplet host/runtime signer or an external signer. The CVM receives the completed signed event, never a private key, signer token, delegated signing secret, or unrestricted signing capability.
- **D-105:** The coordinator independently verifies canonical event serialization, event ID, signature, owner public key, kind/tags/content, d-tag, artifact hash, capability digest, intent identity, and expiry before any deployment or relay effect. A generic invalid-signature response avoids an ownership oracle.
- **D-106:** The user's signed owning manifest and the CVM build attestation are distinct immutable events. The attestation cites the owning event ID, artifact hash, source session/artifact version, promoted toolchain/policy identities, validation evidence, and server timestamp; it cannot claim ownership or sign on the user's behalf.

### Publication State and Reconciliation

- **D-107:** Publication is an explicit signed ContextVM command over a persisted intent. The intent binds owner, session, artifact, manifest template/digest, d-tag, capability digest, signed-event identity, CLI compatibility identity, and server operation IDs before external I/O.
- **D-108:** Deployment uses the promoted `@napplet/cli` contract and exact sealed bytes already previewed; it never rebuilds or regenerates a manifest. The CLI remains an adapter behind a transport-neutral publication port so package contract changes are fixed/promoted upstream rather than reimplemented locally.
- **D-109:** Deployment, manifest publication, and attestation publication each have durable intent and observation identities. Exact replay returns linked results; conflicting reuse fails closed; timeout or lost response becomes `publication_reconciliation_pending` and queries the original operation instead of redeploying, re-signing, or emitting a second event.
- **D-110:** A durable terminal publication result links deployment identity, user manifest event ID, CVM attestation event ID, artifact aggregate hash, and evidence references. A partial external outcome remains visible and recoverable without presenting the napplet as fully published.

### User Flow and Presentation

- **D-111:** The host presents one linear flow: verified artifact summary → sealed preview → capability/compatibility review → explicit publish approval → local/external signature → deployment/reconciliation status. Publication is never a side effect of preview or top-up.
- **D-112:** The default surface is compact and artifact-first: preview occupies the primary area; identity, validation, capability, signing, and publication facts appear in an inspectable side panel or step sheet. Destructive/conflicting states require explicit acknowledgment, while exact replay stays quiet and fluid.
- **D-113:** Status copy uses concrete next actions (`preview`, `review_capabilities`, `sign_manifest`, `publish`, `reconcile_publication`) and never exposes source, prompts, chain-of-thought, private signing material, storage credentials, or native CLI/provider payloads.

### the agent's Discretion

- Choose exact schema/table names, descriptor encoding, grant lifetime, pagination, safe display labels, and stable error codes while preserving D-96–D-113.
- Choose the smallest host-facing preview and signer interface that can be exercised deterministically without building a second napplet runtime.
- Choose publication operation ordering after official `@napplet/cli` and NIP-5D research, provided intent is durable before effects, signed ownership is verified before deployment/publication, sealed bytes never change, and every ambiguous effect reconciles by its original identity.
- Choose compact responsive layout details for the host-rendered preview/review flow; reuse the runtime's design system rather than introducing a standalone CVM visual brand.

### Deferred Ideas (OUT OF SCOPE)

- Production signing-runtime certification, relay/provider selection, multi-region publication recovery, exhaustive supply-chain proof, and launch promotion remain Phase 7 work.
- Public x402/L402 publication adapters remain outside v1.0.
- Automatic publication, CVM-held user keys, delegated long-lived signing authority, and arbitrary non-napplet deployment remain excluded.
</user_constraints>

## Project Constraints (from AGENTS.md)

- Prefer codebase-memory graph discovery for code relationships; preserve the permanent napplet-only, ContextVM-v1, prepaid-cap, no-user-key, and `@napplet/cli` boundaries. [VERIFIED: repository AGENTS.md]
- Treat runtime messages, signed-event returns, generated artifacts, and provider output as untrusted; expose only allowlisted public fields. [VERIFIED: repository AGENTS.md]

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|---|---|---|
| PREV-01 | Preview exact immutable validated artifact. | Durable verified-artifact lookup, sealed-object generation/checksum binding, expiring descriptor. |
| PREV-02 | NIP-5D `allow-scripts`-only preview. | Host-owned iframe/source binding and safe-status-only interface. |
| PREV-03 | Required/optional capability review. | Manifest-derived normalized capability digest and runtime compatibility result. |
| PREV-04 | Clear incompatibility/graceful degradation. | Required blocks, optional degrades, no direct fallback. |
| PUB-01 | Explicit exact publication intent. | Intent fingerprint/version/expiry/replay conflict fence. |
| PUB-02 | Trusted/external user signing only. | Owner-bound canonical template and signed-event submission port. |
| PUB-03 | Verify user event and issue separate attestation. | NIP-01 verifier plus distinct CVM attestation port. |
| PUB-04 | Deploy sealed bytes via promoted CLI. | Pinned CLI adapter and linked operation result. |
| PUB-05 | Exact replay and timeout reconciliation. | Child effect intents plus original-operation observation. |
</phase_requirements>

## Summary

Implement Phase 6 as a transport-neutral publication authority, not as a CVM dashboard. ContextVM returns strictly allowlisted descriptors and commands; a compatible host renders the approved host-native UI, owns the NIP-5D iframe and signer UX, and returns only safe status or a complete signed event. The coordinator alone selects artifacts, issues grants, persists intent/effects, verifies signatures, and projects results. [VERIFIED: repository `src/contextvm/adapter.ts`, `06-CONTEXT.md`, `06-UI-SPEC.md`]

Carry one immutable identity throughout: owner account/principal, session/version, artifact version, aggregate hash, exact sealed-object generation/checksum, manifest/capability digest, validation-evidence ID, and toolchain/policy/CLI identity. Any mismatch denies rather than substitutes bytes or broadens consent. [VERIFIED: repository D-97–D-108, Phase 1–5 verification]

NIP-5D’s current contract supports this boundary: host iframe identity is a `(dTag, aggregateHash)` mapping keyed by `MessageEvent.source`; the iframe uses `sandbox="allow-scripts"` without `allow-same-origin`; `requires` tags negotiate capabilities; unrecognized messages are dropped; and absent capabilities must gracefully degrade. NIP-5D remains open/alpha, so retain the promoted compatibility identity. [CITED: https://github.com/nostr-protocol/nips/pull/2303] [CITED: https://napplet.run/docs/guide/nip-5d.html]

**Primary recommendation:** Add a `publication` domain with durable intent/effect records and narrow `HostPreviewPort`, `ManifestEventVerifier`, `NappletDeploymentPort`, and `AttestationPublisherPort` interfaces. Reuse existing verified-principal, canonical JSON, owner-safe projection, persistence, and reconciliation patterns; do not build an alternative browser runtime, NIP-5D/NIP-5A generator, direct signer API, or deployment client. [VERIFIED: repository `src/contextvm/adapter.ts`, `src/persistence/session-store.ts`, `src/promotion/schema.ts`] [CITED: https://napplet.run/docs/packages/cli.html]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|---|---|---|---|
| Verified artifact and descriptor/grant | API / Backend | Database / Storage | Server resolves the durable verified artifact and exact sealed object. [VERIFIED: repository D-97/D-98] |
| Iframe and NAP message routing | Browser / Client | Host runtime | Host creates the frame and maps `Window` source to artifact identity. [CITED: https://github.com/nostr-protocol/nips/pull/2303] |
| Capability review rendering | Browser / Client | API / Backend | Server derives trusted review facts; host presents them. [VERIFIED: repository D-100, `06-UI-SPEC.md`] |
| User manifest signing | Browser / Client | External signer | Host/external signer owns private key; CVM receives final event only. [VERIFIED: repository D-104] |
| Intent/signature/effect authority | API / Backend | Database / Storage | Durable server authority prevents races and validates all bindings. [VERIFIED: repository D-105/D-109] |
| Deployment/relay/attestation effects | API / Backend | CLI / external services | Pinned adapters run from committed operation identities only. [VERIFIED: repository D-108/D-109] |

## Standard Stack

| Library / contract | Version / pin | Purpose | Required use |
|---|---|---|---|
| Promoted standalone `napplet` CLI | `@napplet/cli@0.5.2`, commit `1a38b9150f3a3da148091c11bce4d0365f7298e5`, Linux asset SHA-256 `46685f2e4df516b5b2e7e2e133480c90e5c85dbd36d05c6e95f4eee6af33ec5e` | Package-owned structured upload, pre-signed relay, progress/result, and success-predicate behavior | Reuse only behind `NappletDeploymentPort`; persist this compatibility ID and require the exact-source contract probe before publication availability. [VERIFIED: repository `toolchains/candidates/cli-0.5.2-release-set.json`] |
| NIP-5D/NIP-5A/NAP | Phase 1 NIP-5D revision `eb45dfd…4c34` | Sandbox, source identity, aggregate/manifest, capability semantics | Consume upstream manifest output; never recreate protocol behavior. [VERIFIED: repository release set] [CITED: https://github.com/nostr-protocol/nips/pull/2303] |
| `nostr-tools` | exact direct `2.24.1` | NIP-01 event ID/signature verification | Declare the exact root dependency autonomously per explicit developer direction and import only `serializeEvent`, `getEventHash`, and `verifyEvent` from `nostr-tools/pure`; exhaustive package certification remains Phase 7. [ASSUMED] [VERIFIED: repository `bun.lock`] |
| `zod` | `4.4.3` existing | Strict command/descriptor/event/status schemas | Follow existing adapter boundary convention. [VERIFIED: repository `package.json`, `src/contextvm/adapter.ts`] |
| Project canonical JSON | `src/promotion/schema.ts` | Internal fingerprints/evidence | Never substitute for NIP-01 serialization. [VERIFIED: repository source] |

## Package Legitimacy Audit

| Package / tool | Registry / distribution | Verdict | Disposition |
|---|---|---|---|
| `nostr-tools@2.24.1` | npm, already resolved transitively in `bun.lock` | SUS (`too-new`) | Developer explicitly authorized an autonomous exact direct pin for the pure verification API; no human trust checkpoint and no perfect-package-validation precondition in Phase 6. Verify root manifest/lock resolution and defer exhaustive legitimacy certification to Phase 7. [ASSUMED] [VERIFIED: repository `bun.lock`] |
| `@napplet/conformance-cli@0.2.18` | existing promoted toolchain lock | SUS (`too-new`, `low-downloads`) | Do not newly install; reuse pinned toolchain only. [ASSUMED] [VERIFIED: repository lock] |
| standalone CLI 0.5.2 | GitHub release asset | existing approved release set | Reuse through port; no npm install. [VERIFIED: repository release set] |
| npm `@napplet/cli@0.0.0` | npm | SUS (`too-new`, `low-downloads`) | **REMOVED** — it is not this project’s promoted CLI distribution. [ASSUMED] [VERIFIED: repository release set] |

**Autonomous exact direct pin:**

```bash
bun add --exact nostr-tools@2.24.1
```

## Architecture Patterns

### System Architecture Diagram

```text
verified artifact + evidence + sealed object
                 |
                 v
PublicationService.getPreviewDescriptor(owner, session, artifact)
                 |
     owner-safe descriptor + expiring single-artifact grant
                 v
            ContextVM preview tool ---> compatible host runtime
                                                |
                       iframe sandbox="allow-scripts" only
                                                |
                      untrusted NAP messages -> safe preview status only
                                                v
                 manifest-derived capability / compatibility review
                                                |
                  explicit approval -> canonical unsigned owner template
                                                |
                              host/external signer (user key stays local)
                                                v
              signed event -> ContextVM publication command -> verifier
                                                |
                  persist publication + child effect intents before I/O
                  /                    |                       \
             deploy sealed bytes    publish user event    publish CVM attestation
                  \                    |                       /
                   original-operation observations / reconciliation
                                                |
                                 complete | partial | pending safe status
```

### Recommended Project Structure

```text
src/publication/
  contracts.ts              # strict schemas and public variants
  preview-service.ts        # verified artifact -> descriptor/review/grant
  publication-service.ts    # intent, verifier, effect orchestration/reconcile
  manifest-event.ts         # NIP-01 wrapper + exact semantic binding
  ports.ts                  # host, CLI, relay, attestation interfaces
  public-status.ts          # owner-safe status projection
src/persistence/publication-store.ts
src/persistence/sqlite-publication-store.ts
src/contextvm/adapter.ts
migrations/phase-06/001_publication.sql
tests/phase-06/*.test.ts
```

File names are prescriptive planning guidance; keep the new domain separate from the Phase 4 generation authority and reuse its verified artifact/session lookup. [VERIFIED: repository source layout] [ASSUMED]

### Pattern 1: Verified artifact → single-artifact descriptor

Create a descriptor only after an owner-scoped lookup proves durable `verified` state. It contains every immutable identity component and an opaque short-lived grant; the grant cannot select bytes, create intent, or authorize signing/publication. [VERIFIED: repository D-97/D-98]

```typescript
const descriptor = PreviewDescriptorSchema.parse({
  subject: { accountId, sessionId, artifactVersion },
  artifact: { aggregateHash, sealedObject: { generation, checksum } },
  review: { manifestDigest, capabilityDigest, validationEvidenceId, toolchainCompatibilityId },
  grant: { id: previewGrantId, expiresAtMs, artifactBindingDigest },
});
```

### Pattern 2: Manifest-derived review

Normalize/deduplicate verified manifest `requires` tags, classify each required/optional capability with server-owned consent copy, and digest the normalized set plus selected runtime compatibility. Required absence is `incompatible`; optional absence is `degraded`; neither enables a direct browser/signer/relay/storage fallback. [VERIFIED: repository D-100–D-102] [CITED: https://napplet.run/docs/guide/nip-5d.html]

### Pattern 3: Exact user-event acceptance

Persist the canonical unsigned template digest in the intent. On signed-event submission, strict-parse fields; recompute NIP-01 ID from its positional UTF-8 serialization; verify Schnorr signature; then compare owner, kind/tags/content, d-tag, aggregate, capability digest, intent ID, and expiry exactly. Return one generic `invalid_manifest` response for every failure. [CITED: https://github.com/nostr-protocol/nips/blob/master/01.md] [VERIFIED: repository D-103–D-105]

Do not use project `canonicalJson` as NIP-01 serialization. [VERIFIED: repository `src/promotion/schema.ts`] [CITED: https://github.com/nostr-protocol/nips/blob/master/01.md]

### Pattern 4: Persist-before-effect publication saga

After accepting the signed event, atomically create/replay the publication and child deployment, owner-manifest, and attestation effect intents. Each has a deterministic operation ID, exact target identity, and `pending|completed|unknown|failed` observation. On timeout, call only `observe(originalOperationId)`; never re-sign, redeploy, or republish. [VERIFIED: repository `src/persistence/session-store.ts`, D-107–D-110]

Recommended ordering is verify signed owner event → persist all intents → deploy exact sealed bytes → publish exact owner event → publish separate attestation. It is an implementation inference that must be proven against the selected CLI adapter, and Phase 7 owns live provider/relay certification. [ASSUMED] [VERIFIED: repository D-107–D-110]

### Pattern 5: Pinned upstream CLI adapter

`NappletDeploymentPort.deployExact()` accepts only the committed operation ID, CLI ID, sealed object generation/checksum, aggregate, template digest, and signed owner event. At the promoted commit, the safe candidate source surface is lower-level structured `uploadFilesToServers`, `publishEventWithSimplePool`, and `networkDeploySucceeded`; the command path performs discovery/planning/signing and `executeNetworkDeploy` combines upload plus relay behind a signer. The adapter must use only a passing repository-owned exact-source contract over the lower-level structured route, supply sealed payloads and the completed owner event directly, and keep server-owned Blossom authorization separate. It must reject/avoid user `nsec`, `nbunksec`, bunker/key references, source workspace collection, command dispatch, dependency/build/rebuild, root/snapshot/multi-target, JSON report, and human stdout paths. [VERIFIED: upstream CLI source at `napplet/web@1a38b9150f3a3da148091c11bce4d0365f7298e5`] [CITED: https://napplet.run/docs/packages/cli.html]

If the sealed release asset cannot expose a supported pre-signed template path, return a truthful design-stage blocked/not-available observation and close the upstream compatibility gap in Phase 7—never replace it with a custom uploader/manifest builder. [VERIFIED: repository Phase 1 design evidence] [ASSUMED]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| Iframe/NAP protocol | CVM-specific browser runtime | compatible NIP-5D host | NIP-5D owns sandbox, source identity, and message behavior. [CITED: https://github.com/nostr-protocol/nips/pull/2303] |
| Aggregate/manifest | server-side hash/tag generator | promoted CLI/vite-plugin output | Upstream owns NIP-5A construction. [VERIFIED: repository Phase 1 verification] |
| Event crypto | custom ID/Schnorr verifier | exact direct `nostr-tools@2.24.1` pure verification API | NIP-01 interoperability/crypto semantics are security critical; no signing/key API is exposed. [CITED: https://github.com/nostr-protocol/nips/blob/master/01.md] |
| Upload/relay publisher | custom Blossom/relay client | promoted CLI adapter | Current CLI owns auth, mirrors, and network observations. [VERIFIED: upstream CLI source] |
| User signer | CVM key form/vault/delegation | host/external signer callback | Preserves key custody. [VERIFIED: repository D-104] |

## Common Pitfalls

- **Artifact swap:** Bind aggregate, sealed generation/checksum, manifest/evidence/toolchain IDs in descriptor and intent; recheck before each effect. [VERIFIED: repository D-97/D-108]
- **Payload-authoritative iframe:** Message payload/event origin must never advance authority; map and validate `MessageEvent.source` and project safe status only. [CITED: https://github.com/nostr-protocol/nips/pull/2303] [VERIFIED: repository D-99]
- **Permission expansion:** Never add `allow-same-origin` or direct authority to work around missing NAPs. [CITED: https://napplet.run/docs/guide/nip-5d.html]
- **Valid but wrong signed event:** Signature validity is insufficient until exact template/owner/intent/expiry binding passes. [VERIFIED: repository D-105] [CITED: https://github.com/nostr-protocol/nips/blob/master/01.md]
- **CLI black box:** The documented `deploy` path owns signing modes; invoke only a tested pre-signed adapter path. [CITED: https://napplet.run/docs/packages/cli.html]
- **Blind retry:** Unknown upload/publish results reconcile their original operation and expose partial/pending, never create a second event/effect. [VERIFIED: repository D-109/D-110]
- **Diagnostic leak:** Use explicit ContextVM/status allowlists and canary tests for source, prompts, credentials, keys, provider payload, and storage data. [VERIFIED: repository D-113, `06-UI-SPEC.md`]

## Code Examples

### Original-operation-only deployment port

```typescript
export interface NappletDeploymentPort {
  deployExact(input: Readonly<{
    operationId: string;
    cliCompatibilityId: string;
    aggregateHash: string;
    sealedObject: { generation: string; checksum: string };
    manifestTemplateDigest: string;
    signedOwnerManifest: unknown;
  }>): Promise<{ status: "completed"; deploymentId: string } | { status: "unknown" } | { status: "failed" }>;

  observe(operationId: string): Promise<{ status: "completed"; deploymentId: string } | { status: "unknown" } | { status: "not_found" }>;
}
```

After an unknown result, only `observe` is callable. The implementation rejects a caller-supplied path, changed aggregate, replacement template, or replacement signed event. [VERIFIED: repository D-108/D-109]

## State of the Art

| Unsafe approach | Required approach | Impact |
|---|---|---|
| Direct browser signer/relay/storage access | NIP-5D host brokers NAP domains for an opaque-origin iframe | Preview does not grant direct authority. [CITED: https://napplet.run/] |
| User key passed to CLI deploy | User signs the exact owner manifest outside CVM; server runs a constrained pre-signed deployment adapter | Preserves key custody and manifest ownership. [VERIFIED: repository D-104/D-108] |
| One `published` flag | Three observed external effects with pending/partial terminal projection | Unknown effects remain recoverable without duplication. [VERIFIED: repository D-109/D-110] |

## External API / Package Capability Inventory

| External contract | Capability consumed | CVM wrapper | Coverage |
|---|---|---|---|
| NIP-5D | allow-scripts frame, `MessageEvent.source`, NAP envelope, unknown drop | `HostPreviewPort` | PREV-02/04 host-contract tests. [CITED: https://github.com/nostr-protocol/nips/pull/2303] |
| NIP-5A / vite output | kind 35129, `d`, `path`, aggregate `x`, `requires` | verified manifest reader | PREV-01/03, PUB-01 same stored manifest identity. [CITED: https://napplet.run/docs/packages/vite-plugin.html] |
| NAPs | required/optional capability behavior | capability review service | PREV-03/04 required blocks, optional degradation. [CITED: https://napplet.run/docs/guide/nip-5d.html] |
| NIP-01 | canonical event ID and signature verification | `ManifestEventVerifier` | PUB-02/03 bad ID/signature/owner/tag/expiry tests. [CITED: https://github.com/nostr-protocol/nips/blob/master/01.md] |
| Promoted CLI 0.5.2 | exact deployment/upload/publish observations | `NappletDeploymentPort` | PUB-04/05 sealed-byte continuity and reconcile tests. [VERIFIED: repository release set] |
| ContextVM SDK bridge | verified public key and response correlation | extended existing adapter | forged payload principal/redaction tests. [VERIFIED: repository `src/contextvm/sdk-bridge.ts`] |
| Server signer/relay | CVM provenance event only | `AttestationPublisherPort` | PUB-03/04/05 distinct event and original-operation reconciliation. [VERIFIED: repository D-106/D-109] |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|---|---|---|
| A1 | Deploy-before-owner-event ordering is correct for the selected CLI contract. | Publication saga | Must change only the persisted orchestration sequence, then retest all partial/reconcile cases. |
| A2 | CVM attestation uses a safe project-owned immutable Nostr event kind/schema. | Attestation | A conflicting/replaceable kind would undermine interoperability/provenance. |
| A3 | Promoted CLI 0.5.2 release asset can expose a safe pre-signed-template adapter route. | CLI adapter | If false, Phase 6 stays design-stage truthful and Phase 7/upstream work must close it. |

## Open Questions (RESOLVED)

1. **RESOLVED — Attestation event kind/tags:** Phase 6 uses a strict project-owned, explicitly non-standard immutable schema. Phase 7 owns ecosystem and relay interoperability certification. [CITED: https://github.com/nostr-protocol/nips/pull/2303] [ASSUMED]
2. **RESOLVED — CLI pre-signed route:** Phase 6 uses the bounded exact-source contract probe for the promoted 0.5.2 route; probe failure truthfully yields `publication_unavailable`. Live binary and provider certification remain Phase 7. [VERIFIED: upstream CLI source] [ASSUMED]
3. **RESOLVED — Host/signer choice:** Phase 6 uses deterministic narrow host and external-signer ports. Selection and certification of the production runtime, signer, relays, and Blossom providers remain Phase 7. [VERIFIED: repository deferred ideas]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---|---|---|
| Bun | service/tests | ✓ | 1.3.14 | — [VERIFIED: local environment] |
| Node/npm | metadata/checkpoint | ✓ | 25.2.1 / 11.6.2 | — [VERIFIED: local environment] |
| Deno | CLI source/contract probe | ✓ | 2.5.6 | pinned image adapter. [VERIFIED: local environment] |
| Promoted CLI Linux asset | worker deployment | not locally runnable on macOS | 0.5.2 | deterministic fake + image contract probe. [VERIFIED: repository Dockerfile] |
| Compatible host, signer, Blossom, relay | production flow | unselected | — | deterministic ports in Phase 6; Phase 7 certification. [VERIFIED: repository deferred ideas] |

## Validation Architecture

### Test Framework

| Property | Value |
|---|---|
| Framework | Bun test. [VERIFIED: repository `package.json`] |
| Quick command | `bun test tests/phase-06 --timeout 10000` [ASSUMED] |
| Full phase command | `bun run eval:phase06 && bun run verify:phase06-design` [ASSUMED] |

### Phase Requirements → Test Map

| Req ID | Test behavior | Command | File Exists? |
|---|---|---|---|
| PREV-01 | exact verified/active artifact descriptor; stale/mismatch/foreign denial | `bun test tests/phase-06/preview-descriptor.test.ts --timeout 10000` | ❌ Wave 0 |
| PREV-02 | exact iframe/source safe-status contract; untrusted message zero effects | `bun test tests/phase-06/runtime-status.test.ts --timeout 10000` | ❌ Wave 0 |
| PREV-03/04 | required/optional review/compatibility/degradation/no fallback | `bun test tests/phase-06/capability-review.test.ts --timeout 10000` | ❌ Wave 0 |
| PUB-01 | intent/invalidation/exact replay/conflict | `bun test tests/phase-06/publication-intent.test.ts --timeout 10000` | ❌ Wave 0 |
| PUB-02/03 | exact template, NIP-01 positive/negative, no secret/no oracle, attestation separation | `bun test tests/phase-06/manifest-signature.test.ts --timeout 10000` | ❌ Wave 0 |
| PUB-04 | exact-source route availability plus sealed byte/hash/CLI identity and linked completion | `bun test tests/phase-06/cli-source-contract.test.ts tests/phase-06/sealed-deployment.test.ts --timeout 10000` | ❌ Wave 0 |
| PUB-05 | duplicate/timeout/restart only observes original effects; partial safe status | `bun test tests/phase-06/publication-reconciliation.test.ts --timeout 10000` | ❌ Wave 0 |

### Wave 0 Gaps

- [ ] All Phase 6 tests listed above, plus the exact promoted-source contract probe/fixture and deterministic host/signer-return/CLI/relay fakes.
- [ ] `migrations/phase-06/001_publication.sql`, memory/SQLite/PostgreSQL parity tests, and publication store.
- [ ] `tests/evals/phase-06-reference-set.test.ts`, `src/verification/phase-06-design-evidence.ts`, and `scripts/verify-phase-06-design-slice.ts` that re-derive comparison results and state real providers as `not_observed`/Phase 7.

## Security Domain

| ASVS category | Applies | Control |
|---|---|---|
| V2 Authentication / V4 Access Control | yes | SDK verified pubkey → principal must equal event pubkey; owner-safe generic denial. [VERIFIED: repository D-103/D-105, adapter] |
| V3 Session Management | yes | Owner/session/artifact version plus expiring grant; no client-selected bytes. [VERIFIED: repository D-97] |
| V5 Input Validation | yes | Strict Zod at ContextVM, host-event, runtime-status, port, and store edges. [VERIFIED: repository adapter] |
| V6 Cryptography | yes | Maintained NIP-01 verifier; isolated server attestation signer; no user key. [CITED: https://github.com/nostr-protocol/nips/blob/master/01.md] |
| V8 Data Protection | yes | Explicit public schemas and protected-canary regressions. [VERIFIED: repository `06-UI-SPEC.md`] |

## Sources

### Primary

- [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) — canonical event serialization/signatures. [CITED: https://github.com/nostr-protocol/nips/blob/master/01.md]
- [NIP-5D PR #2303](https://github.com/nostr-protocol/nips/pull/2303) — sandbox/source/capability contract and open status. [CITED: https://github.com/nostr-protocol/nips/pull/2303]
- [Promoted CLI release set](../../toolchains/candidates/cli-0.5.2-release-set.json) — exact binary/toolchain identity. [VERIFIED: repository]
- [CLI source at promoted commit](https://github.com/napplet/web/tree/1a38b9150f3a3da148091c11bce4d0365f7298e5/packages/cli) — deploy/signing source inspected. [VERIFIED: upstream source]

### Secondary

- [@napplet/cli docs](https://napplet.run/docs/packages/cli.html), [NIP-5D guide](https://napplet.run/docs/guide/nip-5d.html), and [vite-plugin docs](https://napplet.run/docs/packages/vite-plugin.html) — current package behavior; explicitly alpha/non-normative where stated. [CITED: https://napplet.run/docs/packages/cli.html]
- Phase 1–5 source and verification reports — project durable identity, reconciliation, redaction, and provider-separation conventions. [VERIFIED: repository]

## Metadata

**Confidence breakdown:**

- Standard stack: MEDIUM — promoted toolchain identity is verified; NIP-5D/CLI remain moving alpha, the source route is fail-closed behind an exact contract probe, and exhaustive package legitimacy remains Phase 7 work under the developer-authorized autonomous direct pin. [VERIFIED: repository] [CITED: https://napplet.run/]
- Architecture: HIGH — directly follows locked decisions and established intent/reconciliation patterns. [VERIFIED: repository `06-CONTEXT.md`, Phase 3–5 verification]
- Pitfalls: HIGH — grounded in NIP-01, NIP-5D, and inspected CLI source. [CITED: https://github.com/nostr-protocol/nips/blob/master/01.md] [VERIFIED: upstream source]

**Research date:** 2026-08-05
**Valid until:** 7 days. [CITED: https://napplet.run/]
