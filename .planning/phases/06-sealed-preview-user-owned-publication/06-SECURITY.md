---
phase: 06
slug: sealed-preview-user-owned-publication
status: verified
threats_open: 0
threats_total: 51
threats_closed: 51
accepted_risks: 1
asvs_level: 1
block_on: high
created: 2026-08-05
verified: 2026-08-05
---

# Phase 6 — Security

> Verified plan-time STRIDE register for sealed preview, owner-held signing, exact-byte publication, and original-operation reconciliation. Live host, signer, CLI, relay, Blossom, PostgreSQL/Cockroach, and provider certification remains explicitly `not_observed` for Phase 7; every Phase 6 boundary fails closed until those live inputs are validated.

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| ContextVM → transport-neutral core | Only an SDK-verified principal and strict signed action enter the core. | Public identity, action schema, invocation correlation |
| Verified artifact → preview host | Only exact sealed artifact identity and a compatible canonical capability review may produce a descriptor. | Aggregate/file hashes, manifest identity, short-lived read grant |
| External signer → publication core | The CVM accepts only a completed public NIP-01 event and never a user private key. | Public event, signature, canonical intent fingerprint |
| Publication core → promoted CLI facade | The complete promoted source provenance and trusted sealed-file manifest are revalidated before effects. | Exact bytes, d-tag, source commit/SHA/hashes, operation IDs |
| Coordinator → persistence | Intent, owner event, effect claims, and observations are written before or around external effects under idempotency and owner fences. | Owner-scoped durable records, no raw secret/provider output |
| Deterministic evidence → Phase 7 certification | Phase 6 proves deterministic boundaries while live integrations remain explicitly unobserved. | Redacted comparisons, content-addressed evidence, deferral status |

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation evidence | Status |
|-----------|----------|-----------|----------|-------------|---------------------|--------|
| T-06-01-S | Spoofing | Owner event | high | mitigate | `publication-service.ts`, `manifest-event.ts` verify exact event identity and signature before effects. | closed |
| T-06-01-T | Tampering | Artifact/publication binding | high | mitigate | `publication-intent.ts` and `preview-service.ts` recompute and bind sealed artifact identity. | closed |
| T-06-01-R | Repudiation | Publication state | high | mitigate | Publication stores and `001_publication.sql` persist immutable intent, claim, and observation linkage. | closed |
| T-06-01-I | Information disclosure | Public status | high | mitigate | Strict contracts and ContextVM projections expose allowlisted public fields only. | closed |
| T-06-01-D | Denial of service | Replay/concurrency | medium | mitigate | Bounded schemas, durable idempotency, and a single effect claimant. | closed |
| T-06-01-E | Elevation of privilege | Preview/runtime | high | mitigate | Short-lived `preview_read_only` descriptor with `allow-scripts` only. | closed |
| T-06-SC (06-01) | Tampering | Dependency identity | high | mitigate | Root manifest/lock and promoted source-contract checks remain pinned. | closed |
| T-06-02-T | Tampering | Preview descriptor | high | mitigate | Host boundary revalidates owner, artifact, manifest, d-tag, review, and runtime identity. | closed |
| T-06-02-E | Elevation of privilege | Iframe authority | high | mitigate | Sandbox and authority values are closed enums; expanded grants are denied. | closed |
| T-06-02-I | Information disclosure | Runtime messages | medium | mitigate | Tainted host observations are collapsed to finite owner-safe status. | closed |
| T-06-02-D | Denial of service | Capability input | medium | mitigate | Inputs are bounded, canonicalized, and duplicate/conflicting declarations are rejected. | closed |
| T-06-02-S | Spoofing | Manifest/runtime capability | high | mitigate | Sealed declarations are compared with configured runtime availability; required absence blocks before host effects. | closed |
| T-06-SC (06-02) | Tampering | Capability-review dependencies | high | mitigate | Canonical review bytes and hashes execute under locked dependencies. | closed |
| T-06-03-S | Spoofing | Nostr owner event | high | mitigate | `nostr-tools/pure` serialization, hash, and signature verification only. | closed |
| T-06-03-T | Tampering | Manifest semantics | high | mitigate | Exact artifact, d-tag, capability digest, intent, tags, content, and expiry are fenced. | closed |
| T-06-03-R | Repudiation | CVM attestation | high | mitigate | A separate typed provenance attestation cites but never replaces the owner event. | closed |
| T-06-03-I | Information disclosure | Signer/event boundary | high | mitigate | Only bounded public event fields cross; no user secret schema or port exists. | closed |
| T-06-03-D | Denial of service | Event parsing | medium | mitigate | Strict bounded event and signed-command schemas reject malformed inputs. | closed |
| T-06-03-E | Elevation of privilege | Signer/key custody | high | mitigate | Production accepts pre-signed public events only and exposes no signing/key-management capability. | closed |
| T-06-SC (06-03) | Tampering | Nostr verifier dependency | high | mitigate | Exact direct `nostr-tools@2.24.1` pin and pure-only production imports. | closed |
| T-06-04-T | Tampering | Durable publication records | high | mitigate | Identity, uniqueness, foreign-key, and immutable-terminal-state constraints across stores. | closed |
| T-06-04-R | Repudiation | Effect records | high | mitigate | Command, intent, effect kind, original operation, and observation remain linked. | closed |
| T-06-04-I | Information disclosure | Persistence | high | mitigate | Typed protected references are stored instead of raw provider or secret output. | closed |
| T-06-04-D | Denial of service | Transaction contention | medium | mitigate | Immediate/serializable transactions use bounded retry/deadline behavior. | closed |
| T-06-04-E | Elevation of privilege | Principal/effect claim | high | mitigate | Owner-scoped idempotency and compare-and-set single-claim semantics. | closed |
| T-06-04-S | Spoofing | Effect observation | high | mitigate | Only the stored original operation/effect identity can resolve a claim. | closed |
| T-06-SC (06-04) | Tampering | Persistence dependency drift | high | mitigate | SQLite/PostgreSQL adapters reuse the locked project stack and migration contract. | closed |
| T-06-05-S | Spoofing | CLI/relay observations | high | mitigate | Adapter locally parses and validates operation-bound upload and relay results. | closed |
| T-06-05-C | Tampering | CLI source contract | high | mitigate | Exact source facts are validated; absent or changed checkout remains `publication_unavailable`. | closed |
| T-06-05-T | Tampering | Sealed deployment | high | mitigate | Trusted paths, bytes, MIME, sizes, file hashes, canonical aggregate, and d-tag must match. | closed |
| T-06-05-R | Repudiation | Deployment effects | high | mitigate | Claim-before-effect plus immutable operation/observation records. | closed |
| T-06-05-I | Information disclosure | CLI output | high | mitigate | Structured safe observations/status only; no raw stdout/provider output crosses. | closed |
| T-06-05-D | Denial of service | Publication worker | medium | mitigate | One claimant, bounded unknown states, and observation-only reconciliation. | closed |
| T-06-05-E | Elevation of privilege | Upload/relay authority | high | mitigate | Exact-hash upload and completed pre-signed relay paths are separate and contain no secret input. | closed |
| T-06-SC (06-05) | Tampering | CLI supply chain | high | mitigate | Commit, Linux asset SHA, every source-file hash, and closed structured surface are pinned. | closed |
| T-06-06-S | Spoofing | ContextVM caller | high | mitigate | Verified principal/event correlation determines the owner; caller account fields are not trusted. | closed |
| T-06-06-T | Tampering | ContextVM action | high | mitigate | Stored intent/fingerprint and strict action schemas bind every owner-visible transition. | closed |
| T-06-06-C | Tampering | Publication availability provenance | high | mitigate | Commit/SHA/source hashes/surface are carried and revalidated at funded-core, announcement, adapter construction, and dispatch; `c71ee63` regressions reject forged availability. | closed |
| T-06-06-R | Repudiation | ContextVM publication effects | high | mitigate | Invocation, intent, and original operation identity are durably correlated. | closed |
| T-06-06-I | Information disclosure | ContextVM notifications | high | mitigate | Explicit allowlisted notification and host-surface schemas suppress protected fields. | closed |
| T-06-06-D | Denial of service | ContextVM replay | medium | mitigate | Strict bounds and durable idempotency prevent duplicate action/effect execution. | closed |
| T-06-06-E | Elevation of privilege | Cross-surface authority | high | mitigate | Preview, top-up, runtime, and signed publication capabilities remain separate. | closed |
| T-06-SC (06-06) | Tampering | Adapter dependency drift | high | mitigate | ContextVM/Zod dependencies remain locked; source provenance is revalidated. | closed |
| T-06-07-S | Spoofing | Provider observation | high | mitigate | Deterministic observations are distinguished from Phase 7 live `not_observed` facts. | closed |
| T-06-07-C | Tampering | Evidence source contract | high | mitigate | Evidence gate checks exact source constants/API disposition and mutation failures. | closed |
| T-06-07-T | Tampering | Evidence pointer | high | mitigate | Canonical SHA, content-addressed filename, immutable record, and atomic pointer writing. | closed |
| T-06-07-R | Repudiation | Certification evidence | high | mitigate | Independent executed scenario observations and counters are compared to expectations. | closed |
| T-06-07-I | Information disclosure | Evidence serialization | high | mitigate | Only redacted, allowlisted evidence fields are serialized. | closed |
| T-06-07-D | Denial of service | Deterministic evidence gate | low | accept | Bounded reference set and test timeouts; interruption creates no live authority and is rerun. | closed |
| T-06-07-E | Elevation of privilege | Evidence laundering | high | mitigate | Independent scenario results, source/API gates, and honest live deferrals prevent self-attestation. | closed |
| T-06-SC (06-07) | Tampering | Verification supply chain | high | mitigate | Locked packages, exact promoted source identity, and closed API coverage gate. | closed |

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-06-01 | T-06-07-D | The evidence gate runs only a bounded deterministic reference set under test timeouts. A pathological local environment may delay or interrupt it, but this grants no publication, signer, relay, upload, or provider authority; the gate is rerun and never treated as live certification. | Plan 06-07 / autonomous security audit | 2026-08-05 |

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-05 | 51 | 49 | 2 | gsd-security-auditor — initial ASVS L1 audit |
| 2026-08-05 | 51 | 51 | 0 | gsd-security-auditor — re-audit after `c71ee63` |

## Verification Notes

- Exact source-provenance regressions passed: 27 tests across CLI source contract, sealed deployment, ContextVM publication adapter, and funded-core boundaries.
- Full repository regression after mitigation: 424 tests passed.
- No Phase 6 summary contains an unmapped `## Threat Flags` entry.
- Phase 7 retains live host/signer/CLI/relay/Blossom/PostgreSQL/provider certification; Phase 6 does not claim those integrations are observed or available.

## Sign-Off

- [x] All 51 threats have a disposition.
- [x] Accepted risks are documented.
- [x] `threats_open: 0` confirmed at the configured `high` threshold.
- [x] `status: verified` set in frontmatter.

**Approval:** verified 2026-08-05
