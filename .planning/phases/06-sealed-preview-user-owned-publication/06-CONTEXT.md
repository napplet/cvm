# Phase 6: Sealed Preview & User-Owned Publication - Context

**Gathered:** 2026-08-05
**Status:** Ready for planning
**Mode:** Autonomous recommendations accepted under the user's standing autonomy direction

<domain>
## Phase Boundary

Phase 6 turns the latest verified immutable napplet artifact into a host-rendered preview and an explicit, replay-safe publication. It binds preview, capability review, user signing, sealed-byte deployment, the user-owned NIP-5D manifest event, and a separate CVM build attestation to one artifact identity. It does not select production infrastructure, certify multi-region publication, add another public transport, hold a user private key, publish automatically, or reopen the upstream napplet protocol/toolchain contract.

</domain>

<decisions>
## Implementation Decisions

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

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets

- Phase 1 promotion manifests, artifact contracts, aggregate-hash evidence, and immutable design-evidence writers already establish content-addressed identity and fail-closed verification patterns.
- Phase 2 trusted-core artifact verification and worker contracts provide the verified artifact boundary and keep runtime/worker proposals non-authoritative.
- Phase 3 ContextVM SDK bridge, verified-principal adapter, canonical announcement, idempotent PostgreSQL authority, and transactional outbox patterns provide the external command seam.
- Phase 4 metered session/artifact lineage and Phase 5 checkpoint/reconciliation state machines provide owner/version fencing, exact replay, original-operation lookup, and safe status conventions.

### Established Patterns

- Living ContextVM and napplet package types stop at thin adapters; the domain core uses strict transport-neutral ports and Zod schemas.
- External effects are preceded by durable intent and followed by exact observation/reconciliation; ambiguous outcomes never trigger blind retries.
- Evidence and public responses are allowlisted and content-addressed. Provider/package-native payloads and user-sensitive content stay protected.
- Design-stage deterministic proof is sufficient through Phase 6; exhaustive supply-chain, live-provider, relay, signing-runtime, failover, and launch certification belongs to Phase 7.

### Integration Points

- Extend `ContextVmFundingAdapter` and its announcement with preview, publication-intent/status, signed-manifest submission, and reconciliation commands without leaking ContextVM types into the core.
- Extend the durable metered artifact/session authority with exact verified artifact lookup, preview grants, publication intents, effect observations, and terminal linked results.
- Place NIP-5D manifest verification, host preview, signer, Nostr publication, attestation, and `@napplet/cli` operations behind narrow server-owned ports.
- Reuse aggregate hashes, artifact versions, validation evidence, promoted toolchain identity, status redaction, and transaction/outbox conventions rather than defining parallel identities.

</code_context>

<specifics>
## Specific Ideas

- The product runs inside a napplet runtime, so preview and signing should feel native to that host rather than opening an unrelated CVM dashboard.
- “NIP-5D is god”: use and improve the napplet packages for manifest/deployment behavior; do not create a CVM-specific competing protocol implementation.
- The user owns and signs the manifest. The CVM separately attests what it built and verified.
- Keep the experience fluid: exact retries quietly converge, while ambiguous publication shows a clear reconcile state instead of asking the user to sign or publish twice.

</specifics>

<deferred>
## Deferred Ideas

- Production signing-runtime certification, relay/provider selection, multi-region publication recovery, exhaustive supply-chain proof, and launch promotion remain Phase 7 work.
- Public x402/L402 publication adapters remain outside v1.0.
- Automatic publication, CVM-held user keys, delegated long-lived signing authority, and arbitrary non-napplet deployment remain excluded.

</deferred>
