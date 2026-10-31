# napplet-cvm

## What This Is

napplet-cvm is a ContextVM-accessible generation service that turns a bounded text idea into a small, single-purpose, conformant Nostr web applet (a napplet). A user funds a Nostr-linked account, runs an iterative metered agent session, previews the generated napplet inside a real sandboxed runtime, and publishes verified deployment files plus a user-owned napplet manifest and CVM build attestation.

The generation core is transport-neutral. ContextVM over Nostr is the only external interface in v1, with CEP-8 used for account top-ups; future adapters may expose the same core through x402 and L402 without changing generation, billing, or session semantics.

## Core Value

A user can describe one focused applet and receive a safe, conformant napplet that can be previewed and placed directly into a compatible napplet runtime.

## Active Milestone

**ID:** v1.0

**Name:** Safe Napplet Generation MVP

**Goal:** A funded ContextVM user can submit a bounded idea and receive a safe, conformant, resumable, user-owned napplet that can be previewed and placed into a compatible napplet runtime.

**Scope:** The existing roadmap Phases 1–7: napplet contract verification; trusted-core and worker isolation; ContextVM/CEP-8 funding; exact-usage generation and revision; funding interruption and durable resume; sealed preview and user-owned publication; and measured launch resilience/safety.

**Exclusions:** Existing v1 exclusions remain unchanged: arbitrary/full-stack applications and generated backends; rich or existing-code inputs; direct browser/network/storage/signer/relay authority; CVM custody of user private keys; automatic publication; durable request queues; automatic resume after the ten-minute live window; indefinite checkpoint retention; and public x402/L402 interfaces. Deferred v2 requirements are not part of v1.0.

**Completion outcome:** v1.0 is complete when the existing v1 requirements demonstrate, end to end, that:

- A Nostr-identified user can discover the service through ContextVM, fund a prepaid account through CEP-8 using Lightning or Cashu, approve a spend cap, and be charged exactly once for measured API usage.
- One bounded text idea starts isolated work immediately or receives a retryable capacity response; the agent can produce only a focused napplet through the promoted napplet toolchain and every previewable artifact passes the required safety and conformance gates.
- Generation and revision state is serialized, recoverable after insufficient funds, resumable through the ten-minute live window and 30-day durable checkpoint contract, and never silently restarted by a later deposit.
- The user previews the exact verified artifact, retains sole signing authority over the owning manifest, and explicitly publishes sealed bytes through `@napplet/cli` with a separate CVM build attestation.
- Integrated load and failure evidence supports the five-second p95 admission claim and shows no duplicate charge, session mutation, settlement credit, publication, or loss of committed checkpoint/artifact/evidence state; all Phase 1 launch-hardening deferrals are closed in Phase 7.

## Business Context

- **Customer**: Nostr users and napplet-runtime users who want to create focused applets without manually building them
- **Revenue model**: Prepaid, metered generation charged against a Nostr-linked balance according to actual API usage; any service margin or fee policy remains to be defined
- **Success metric**: Funded requests begin isolated execution within five seconds at p95 and reliably produce conformant previewable napplets
- **Strategy notes**: ContextVM is the v1 interface, not the service boundary; x402 and L402 are planned adapter opportunities

## Requirements

### Validated

- [x] The executable artifact contract accepts only small, single-purpose sandboxed napplets and rejects arbitrary web, backend, and multi-purpose application shapes. — Validated in Phase 1: Napplet Contract & Artifact Verification.
- [x] Direct network, browser storage, signer, relay, service-worker, external-asset, and undeclared/unnecessary capability paths fail closed behind the shell-mediated NIP-5D/NAP boundary. — Validated in Phase 1.
- [x] The approved napplet compatibility set is identity-bound to a resource-bounded, secret-free, default-deny sealed runner with canonical blocked evidence. — Validated in Phase 1.

### Active

- [ ] A Nostr user can discover and invoke the generation service through ContextVM.
- [ ] A user can top up their Nostr-linked prepaid balance through CEP-8 using Lightning or Cashu payment methods.
- [ ] A user can approve a maximum spend for a generation session while being charged only for actual API usage.
- [ ] A bounded text prompt starts an isolated generation session within five seconds at p95 without waiting in a request queue.
- [ ] The agent uses `@napplet/skills` and the authoritative napplet scaffold to design, build, repair, and test a napplet.
- [ ] Every generated napplet passes required build, forbidden-authority, and real-browser conformance checks before preview or publication.
- [ ] A user can preview the exact verified build in a compatible sandboxed napplet runtime before publishing it.
- [ ] A user can iteratively request revisions in the same session, with each billable action metered and visible.
- [ ] Publication deploys through `@napplet/cli`, produces the napplet manifest/event, includes a CVM build attestation, and requires the user to sign the owning manifest without exposing their private key to the CVM.
- [ ] When balance cannot cover the next billable action, the agent checkpoints safely and asks the user to top up instead of failing the session.
- [ ] A paid top-up within ten minutes resumes the live session; after ten minutes the worker is released and the full session can be explicitly resumed from a durable checkpoint.
- [ ] Durable session checkpoints preserve conversation, agent state, workspace files, validation evidence, usage ledger, and the pending action for 30 days.
- [ ] Input validation, strict size limits, prompt-injection and jailbreak detection, spend enforcement, capability policy, and output scanning defend the service and generated artifact.
- [ ] The service remains available across infrastructure failures without double charging, double publishing, or losing committed session progress.

### Out of Scope

- Arbitrary websites or full-stack applications — napplets are sandboxed, single-purpose applets by definition.
- Generated backend services — v1 output is a serverless napplet/nsite that depends on shell-brokered NAP capabilities.
- Direct `fetch`, XHR, WebSocket, browser storage, cookies, `window.nostr`, external assets, or app-owned signing/relay infrastructure — these violate the napplet sandbox contract.
- Image, file, URL, repository, or existing-code input — v1 accepts bounded text prompts and text revision messages only.
- Automatic publication immediately after generation — the user previews before choosing to publish.
- Service custody of user private keys — the user signs the owning manifest through the trusted runtime/signer boundary.
- Public HTTP, x402, or L402 interfaces in v1 — keep adapter seams but defer their external contracts.
- Durable request queues — requests start immediately or are rejected; persisted paused sessions are explicit checkpoints, not queued work.
- Indefinite abandoned-session retention — checkpoints expire after 30 days.

## Context

- A napplet is a NIP-5D sandboxed iframe application: small, focused, composed by a trusted host shell, and identified by its manifest d-tag plus aggregate build hash.
- The web sandbox uses `allow-scripts` without `allow-same-origin`. Sensitive actions are mediated by typed NAP domains over `postMessage`; the shell owns identity, storage, relay access, signing, resource access, and consent.
- New napplets must be scaffolded from the authoritative napplet boilerplate, implemented through `@napplet/sdk`, and generated by an agent harness that follows `@napplet/skills`.
- Expected validation includes the maintained verification command and Chromium-backed napplet conformance suite. Publication and deployment metadata are owned by `@napplet/cli`.
- ContextVM transports MCP/JSON-RPC messages over signed Nostr events. Public keys provide the persistent identity used for authorization and account association.
- CEP-8 separates capability-price discovery from settlement and negotiates payment methods through PMIs. In v1, a separate top-up capability accepts Lightning and Cashu, while generation debits actual usage from the resulting account balance.
- Top-ups do not automatically restart a checkpoint older than ten minutes. Explicit resume prevents surprising expenditure of newly deposited funds.
- Use a provider-neutral application with ordinary container deployment through Ansible on homelab or a VPS. Reuse the existing Coolify deployment; Google Cloud is excluded. Do not introduce an enterprise platform or parallel provider graph.
- The napplet and ContextVM ecosystems are experimental and evolving, so protocol/package versions and authoritative constraints must be verified against current official sources during planning.

## Constraints

- **Artifact**: Output must always be a conformant, single-purpose sandboxed napplet — this is a permanent product boundary.
- **Input**: Text only with strict character/token limits — reduces attack surface and bounds cost.
- **Transport**: ContextVM is the only public v1 interface — the core must remain independent so future x402/L402 adapters do not require a rewrite.
- **Payments**: CEP-8 top-ups through Lightning and Cashu fund a Nostr-linked prepaid ledger — generation itself charges exact API usage.
- **Spend safety**: Every session has a user-approved maximum and cannot spend beyond that cap or funded balance.
- **Availability**: New accepted work begins isolated execution within five seconds at p95, with no durable request queue.
- **Continuity**: Insufficient balance pauses rather than fails; live workers wait ten minutes, then durable checkpoints support explicit resume for 30 days.
- **Security**: Treat prompts, generated code, tool output, dependencies, and napplet runtime messages as untrusted; enforce layered input, agent, filesystem/network, capability, output, and publication controls.
- **Key custody**: The CVM never receives or stores a user's Nostr private key.
- **Deployment**: Use `@napplet/cli` and its manifest/deployment contract rather than reimplementing publication.
- **Infrastructure**: Provider-neutral adapters; simple Ansible/container deployment to homelab or a VPS. Google Cloud is excluded.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Nostr public key anchors the user account | Matches ContextVM identity and avoids a separate conventional login | — Pending |
| ContextVM is the sole v1 interface over a transport-neutral core | Serves the napplet runtime now while preserving future x402/L402 adapters | — Pending |
| CEP-8 is used for separate account top-ups | Preserves standard ContextVM payment negotiation while allowing exact post-usage debits | — Pending |
| Support Lightning and Cashu payment methods | Gives users both invoice-based and bearer-value funding paths | — Pending |
| Require a user-approved job cap and debit exact usage | Bounds exposure without converting variable generation into a fixed-price product | — Pending |
| Accept bounded text only | Keeps v1 focused and materially reduces injection, exfiltration, and ingestion risk | — Pending |
| Generate sandboxed napplets only | Aligns output with NIP-5D rather than treating napplets as generic apps | — Pending |
| Preview the verified build before publication | Keeps the user in control and prevents surprise publication | — Pending |
| CVM attests; user owns and signs the manifest | Provides provenance without service custody of the user's private key | — Pending |
| Meter revisions inside an iterative session | Makes the product useful for creation while keeping every generation step accountable | — Pending |
| Pause for top-up instead of failing | Preserves expensive agent progress when a balance runs low | — Pending |
| Wait live for ten minutes, then checkpoint for 30 days | Balances instant continuation, compute cost, privacy, and recoverability | — Pending |
| Require explicit resume after the live window | Prevents an unrelated later deposit from unexpectedly restarting spend | — Pending |
| No durable request queue | Meets the immediate-start product promise; checkpointed sessions are paused state, not scheduling backlog | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `$gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `$gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-08-04 after Phase 1 completion*
