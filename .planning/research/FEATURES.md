# Feature Research

**Domain:** Secure, prepaid ContextVM service that generates and publishes NIP-5D napplets
**Researched:** 2026-08-03
**Confidence:** MEDIUM — NIP-5D and the napplet packages are alpha/experimental; the product requirements are clear, but protocol and package details must be re-checked at implementation time.

## Feature Landscape

### Table Stakes (Users Expect These)

For this product, “table stakes” means behavior a user must be able to rely on before funding a session—not generic web-app functionality.

| Feature | Expected observable behavior | Complexity | Depends on | Release |
|---------|------------------------------|------------|------------|---------|
| Nostr-native discovery and account identity | A signed ContextVM request discovers the service and resolves to one stable Nostr public-key account; retries from the same identity do not create another balance or session. No password or service-held user secret is required. | HIGH | ContextVM server announcement/transport, signature verification, account mapping, request idempotency | v1 |
| CEP-8 top-up capability with Lightning and Cashu | The client can request a top-up quote, choose Lightning or Cashu, and sees `pending`, `settled`, `credited`, or `failed`. The balance changes once per verified settlement and records rail, amount, unit, and settlement reference. Cashu acceptance validates amount, unit, and trusted mint before credit. | HIGH | ContextVM/CEP-8 payment negotiation, Lightning processor, Cashu verifier/trusted-mint policy, idempotent prepaid ledger | v1 |
| Hard session cap plus exact-usage ledger | Before a billable action, the user approves a session maximum. Each completed agent/model action reports a line item (usage inputs, unit price/version, actual debit, remaining balance, remaining cap); the total never exceeds the lesser of funded balance and cap. A failed/retried transport request cannot double debit. | HIGH | Pricing snapshot, metering adapters, transactional ledger, action idempotency, worker lifecycle | v1 |
| Immediate, bounded generation session | A valid funded request either starts an isolated worker within the five-second p95 target or is rejected clearly—never silently added to a durable queue. The user receives a session id, state, cap, and first progress update. | HIGH | Admission control, warm/isolation-capable workers, capacity limits, session state machine | v1 |
| Iterative text-only revisions | The user can send bounded text revisions to the same session and receive status plus the next verified artifact. Every revision is separately authorized against balance/cap and visible in the ledger. | HIGH | Durable conversation/agent state, prompt limits/scanning, per-action billing, artifact versioning | v1 |
| Conformance-first build and repair loop | The service scaffolds through the authoritative napplet tooling, builds, runs forbidden-authority/static checks and the real-browser conformance suite, and repairs only while the next action is authorized. It returns validation evidence and does not label an artifact previewable/publishable until checks pass. | HIGH | `@napplet/skills`, boilerplate, SDK, build toolchain, conformance runner, isolated browser, artifact storage | v1 |
| Exact verified sandbox preview | Preview launches the same immutable aggregate-hash build that passed validation in a compatible NIP-5D shell. The result is an `allow-scripts` opaque-origin iframe without `allow-same-origin`; sensitive Nostr operations remain through supported NAP capabilities. A preview must show unavailable capabilities as graceful degradation, not bypass the shell. | HIGH | Aggregate-hash artifact store, compatible runtime/shell, NIP-5D verification, preview authorization | v1 |
| User-owned publication/signing boundary | After preview, the user explicitly chooses publish and the trusted runtime/signer signs the user-owned named-napplet manifest. The CVM never receives a private key, never invokes `window.nostr`, and cannot publish a manifest as the user. The response links the user-signed manifest/event, the deployed files, and the exact aggregate hash. | HIGH | `@napplet/cli` publication contract, runtime signer handoff, Nostr event verification, deployment idempotency | v1 |
| Funding interruption, live grace, and durable resume | If remaining authorization cannot cover the next billable action, work stops at a safe boundary, records a `needs_top_up` pending action, and asks for a top-up. A verified top-up within ten minutes continues the live worker. Later top-ups leave the session paused until an explicit resume; checkpoints are resumable for 30 days then expire. | HIGH | Preflight authorization, checkpoint writer, ten-minute worker lease, top-up settlement event, 30-day retention/expiry scheduler | v1 |
| Security and artifact-scope policy | The service accepts only size-limited text, treats prompts/tool output/generated code as untrusted, and rejects output that is not a small single-purpose napplet or that asks for authority outside NAP-mediated shell capabilities. | HIGH | Input/prompt policy, sandboxed agent tools, dependency/output scanning, conformance policy | v1 |

### Differentiators (Competitive Advantage)

| Feature | Value proposition and observable behavior | Complexity | Depends on | Release |
|---------|-------------------------------------------|------------|------------|---------|
| Honest variable-cost generation | Unlike a fixed-price “generate” call, the UI exposes actual usage per completed action while the cap remains an absolute ceiling. The service preflights each action, settles its measured cost, and shows any unused authorization as still available—not as a hidden service fee. | HIGH | Immutable double-entry-style usage ledger, cost normalization, reservations/settlement policy, cap enforcement | v1 |
| Two-tier continuity without surprise spending | The ten-minute live continuation makes an accidental low balance feel recoverable; the 30-day explicit-resume checkpoint prevents a later unrelated deposit from restarting a costly agent run. The user can inspect what action will run before resuming. | HIGH | Serializable workspace/agent state, versioned checkpoint format, worker lease/release, resume authorization | v1 |
| Repairable conformance, not just code generation | The product returns a usable napplet or a precise blocked state with test evidence. Repair is constrained to the same sandbox/capability policy, so “fixing” cannot turn the artifact into a generic site with direct network, storage, or signer access. | HIGH | Deterministic validation gates, repair agent harness, artifact diff/version store, cost guard | v1 |
| Provenance bundle and CVM build attestation | Each publishable build gets a CVM-signed attestation that binds the aggregate hash to generator/toolchain versions, policy/conformance results, timestamp, and source session/artifact identifiers. It is distinct from—and references rather than substitutes for—the user-signed manifest. | HIGH | Stable attestation schema, service signing key/rotation, artifact hashes, validation evidence, publication linkage | v1 |
| Capability-minimal napplet design | The generator derives only the NAP domains needed by the focused applet and includes capability requirements in the manifest. The user can see required capabilities before publish, and an unsupported runtime produces a clear degraded experience. | MEDIUM | Intent-to-capability policy, NAP registry/schema validation, manifest generation, preview runtime | v1 |

### Anti-Features (Commonly Requested, Often Problematic)

These are permanent v1 product boundaries unless the project’s stated artifact/security model is deliberately changed.

| Anti-feature | Why requested | Why problematic | Alternative | Release |
|--------------|---------------|-----------------|-------------|---------|
| Arbitrary websites, full-stack apps, or generated backends | Users may want a general app builder. | Violates the napplet’s focused, shell-mediated model; adds unbounded attack surface, hosting, data, and cost. | Generate one small NIP-5D napplet/nsite that uses only supported NAP capabilities. | Permanent boundary |
| Direct `fetch`, XHR, WebSocket, browser storage/cookies, `window.nostr`, shell, or relay access | Makes a generated app seem more capable quickly. | Defeats opaque-origin sandboxing and the NIP-5D authority boundary; enables data exfiltration and key/identity abuse. | Request narrowly scoped shell-provided NAP domains and degrade gracefully when absent. | Permanent boundary |
| Service custody, delegation, or injection of user private keys | Seems to simplify one-click publish. | Breaks user ownership and creates a catastrophic key-custody target. A valid Nostr event identifies its author through that author’s public key and signature. | Prepare the manifest/deployment; require the trusted runtime/signer to sign only after explicit user consent. | Permanent boundary |
| Automatic publication after a successful build | Removes a confirmation step. | Publishes an artifact the user has not run in their runtime or approved; bypasses the signer/ownership boundary. | Always preview the exact verified hash, then make publication an explicit, separately confirmed action. | Permanent boundary |
| Overages, automatic top-ups, or cap increases during a run | Avoids interruptions. | Turns a prepaid safety control into surprise spending; exact cost is only known after a model action completes. | Hard preflight on balance and cap; pause before the next action and require an explicit top-up/new approved cap. | Permanent boundary |
| Silent auto-resume after the ten-minute live window | Appears convenient after a later deposit. | Can spend a new deposit without contemporaneous intent and requires holding workers or background scheduling. | Release worker at ten minutes; retain a 30-day checkpoint and require explicit resume plus a displayed pending action. | Permanent boundary |
| Durable request queue | Seems useful under load. | Conflicts with the immediate-start promise and obscures when a user’s prepaid run will begin. | Admission control: start within target or reject; only already-started paused sessions are persisted. | Permanent boundary |
| Image, file, URL, repository, or existing-code ingestion | Allows richer prompts. | Greatly expands malware, secret-exfiltration, licensing, and cost risks before the core value is validated. | Bounded idea and revision text only. | Permanent boundary |
| “Preview anyway” for failed or unverified builds | Lets users inspect partial output. | Conflates diagnostics with a runtime-compatible artifact and can train users to accept nonconformant output. | Return logs/diffs as diagnostics; preview only an immutable build with passing required gates. | Permanent boundary |

## Feature Dependencies

```text
Signed ContextVM request + Nostr pubkey
    └──requires──> account mapping + idempotent prepaid ledger
                          └──requires──> verified CEP-8 Lightning/Cashu top-up
                                                └──requires──> balance available
                                                      └──requires──> approved session cap
                                                            └──requires──> preflighted billable action

Preflighted billable action
    └──requires──> isolated agent worker + checkpoint state
                          └──produces──> versioned artifact + exact usage ledger entry
                                                └──requires──> conformance gates
                                                      └──enables──> verified sandbox preview
                                                            └──enables──> explicit user-signed publication
                                                                  └──links──> CVM build attestation

Insufficient authorization
    └──requires──> durable checkpoint + pending action
                          ├──within 10 minutes + settled top-up──> live continuation
                          └──after 10 minutes──> explicit 30-day resume
```

### Dependency Notes

- **Identity requires the ledger before generation:** The public key is the account key, but the signed request/event id must be de-duplicated before either a credit or debit is committed.
- **Top-up requires settlement verification, not a client assertion:** ContextVM’s documented paid flow waits for settlement verification before forwarding work. Cashu merchant guidance also requires token/mint validation and a swap before treating payment as complete.
- **Exact billing requires a preflight plus a completion record:** A cap must be enforced *before* launching the next chargeable action; its actual model cost must be written atomically after completion. A pricing/reservation policy that cannot bound worst-case next-action cost must decline that action and pause.
- **Preview requires conformance and content identity:** The shell maps an iframe to the `(dTag, aggregateHash)` identity and NIP-5D’s current draft has the runtime verify manifest/files before injection. A dev server preview or rebuilt artifact is not an acceptable substitute.
- **User signing follows preview:** Build conformance establishes that bytes are safe to load; it does not authorize publication. The runtime signer must sign the user manifest after preview/consent, while the CVM separately signs only its provenance statement.
- **Resume is an authorization decision:** A top-up keeps a live worker only during the stated ten-minute window. Beyond it, a 30-day checkpoint has no authority to restart until the user sends a resume command.

## MVP Definition

### Launch With (v1)

- [ ] Nostr/ContextVM discovery and pubkey-account mapping — the only public interface and authorization anchor.
- [ ] CEP-8 top-up capability for Lightning and Cashu with credited-on-verification semantics — makes prepaid use possible without billing a generation call directly.
- [ ] Hard cap, exact action ledger, idempotent charge/credit handling — non-negotiable user-spend safety.
- [ ] Immediate isolated session, bounded text revisions, and visible state/action status — proves the creation loop.
- [ ] Scaffolded napplet generation, deterministic build, authority policy checks, browser conformance, and constrained repair — proves output is a napplet, not generic generated code.
- [ ] Exact-hash runtime preview — validates the result in the environment that will run it.
- [ ] Explicit user-signed publication plus CVM attestation — preserves ownership and supplies provenance.
- [ ] Ten-minute live top-up grace and 30-day explicit checkpoint resume — preserves paid work without surprise restart.

### Add After Validation (v1.x)

- [ ] Per-model/service margin policy and user-facing cost estimates — add once measured usage distributions allow estimates that do not weaken the hard-cap promise.
- [ ] Capability consent presentation and richer compatibility reports — add after support matrices for real runtimes/NAPs are observed.
- [ ] Checkpoint export/delete controls and attestation verifier UX — add when users need portability/audit beyond the retained session lifecycle.
- [ ] Multiple trusted Cashu mint policy and automated treasury settlement — add only after a safe single/allowlisted mint flow is operationally proven.

### Future Consideration (v2+)

- [ ] x402 and L402 transport/payment adapters — keep an internal adapter seam, but do not expose new public contracts before ContextVM semantics are proven.
- [ ] Additional artifact inputs (repository/files/images/URLs) — defer pending a separate ingestion, provenance, licensing, and malware model.
- [ ] Collaborative/shared sessions — defer because account ownership, cap consent, manifests, and checkpoint privacy become multi-principal.

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Pubkey account + ContextVM invocation | HIGH | HIGH | P1 |
| CEP-8 Lightning/Cashu top-up + idempotent ledger | HIGH | HIGH | P1 |
| Cap-enforced exact per-action billing | HIGH | HIGH | P1 |
| Conformance-first generation and repair | HIGH | HIGH | P1 |
| Exact verified sandbox preview | HIGH | HIGH | P1 |
| User-owned signed publication + CVM attestation | HIGH | HIGH | P1 |
| Ten-minute grace + 30-day explicit resume | HIGH | HIGH | P1 |
| Capability-minimal manifest/consent UX | MEDIUM | MEDIUM | P2 |
| Better estimates, costs, and attestation verification UX | MEDIUM | MEDIUM | P2 |
| x402/L402 adapters and collaborative generation | MEDIUM | HIGH | P3 |

**Priority key:**

- P1: Must have for launch
- P2: Should have after core behavior is proven
- P3: Future consideration

## Evidence and Requirement Interpretation

- NIP-5D is currently an open/experimental NIP draft. Its current design requires `sandbox="allow-scripts"` without `allow-same-origin`, binds the sandboxed iframe to a verified `(dTag, aggregateHash)`, and routes sensitive behavior through NAP capability domains. Treat every NIP-5D/NAP version as a phase-specific verification point, not a frozen dependency. [NIP-5D draft](https://github.com/nostr-protocol/nips/pull/2303) · [official napplet orientation](https://napplet.run/docs/guide/nip-5d.html)
- The napplet Vite tooling documents build-time per-file/aggregate hashing, a kind `35129` manifest, capability tags, and build-time guards; it explicitly describes the ecosystem as alpha. [@napplet/vite-plugin](https://napplet.run/docs/packages/vite-plugin.html)
- ContextVM’s current payment docs model price discovery/settlement as a capability flow that sends `payment_required`, waits for verified settlement, sends `payment_accepted`, then forwards work. napplet-cvm should use that flow for a separate top-up capability, then debit its own exact-usage ledger—this latter separation is a deliberate product inference from `PROJECT.md`, not a CEP-8 rule. [ContextVM payments getting started](https://docs.contextvm.org/how-to/payments/getting-started/)
- Cashu merchant guidance says a service must validate amount, unit, and trusted mint, then swap before considering a token payment complete; accepting arbitrary mints instead requires a successful immediate melt and fee handling. [Cashu merchant guidance](https://docs.cashu.space/merchants)
- Nostr events are author-bound: the event contains the author public key and a Schnorr signature. Therefore, “user-owned manifest” must mean the user’s signer produces that event; a CVM attestation is supplementary provenance, not a replacement author signature. [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)

## Sources

- [NIP-5D draft — sandbox, identity, aggregate hash, capability negotiation](https://github.com/nostr-protocol/nips/pull/2303) — MEDIUM (current official draft; experimental)
- [napplet NIP-5D guide](https://napplet.run/docs/guide/nip-5d.html) — MEDIUM (first-party orientation, explicitly non-normative)
- [@napplet/vite-plugin documentation](https://napplet.run/docs/packages/vite-plugin.html) — MEDIUM (first-party package documentation)
- [ContextVM payments: getting started](https://docs.contextvm.org/how-to/payments/getting-started/) — MEDIUM (first-party documentation)
- [Cashu merchant guidance](https://docs.cashu.space/merchants) — MEDIUM (first-party documentation)
- [NIP-01 event ownership/signatures](https://github.com/nostr-protocol/nips/blob/master/01.md) — HIGH (official Nostr protocol)
- [OpenRouter cap guidance](https://openrouter.zendesk.com/hc/en-us/articles/51690568268059-How-do-I-cap-my-spending-and-stop-runaway-usage-from-coding-agents) — LOW (general billing analogy; used only to corroborate preflight-cap reasoning)

---
*Feature research for: napplet-cvm*
*Researched: 2026-08-03*
