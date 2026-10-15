# Phase 7 Development GUI — Implementation Context

**Gathered:** 2026-10-15
**Status:** Locked for development execution
**Source:** User's development-GUI objective plus verified local SDK/payment probes

<domain>
## Development Boundary

This development continuation delivers a working local browser interface for the existing napplet-cvm execution flow. The browser must traverse the real signed and encrypted ContextVM-over-Nostr wire, the local relay, the existing adapter, PostgreSQL money/session authorities, a real isolated napplet worker, the maintained build and conformance gates, and a compatible sandboxed host before the UI reports success.

Production provisioning, protected certification, promotion, and Plans 07-20/07-26 remain deferred. Development evidence may exercise behavior related to `SESS-02` and `OPS-01`–`OPS-04`, but it does not complete or certify those production requirements.
</domain>

<requirements>
## Development Requirement IDs

These IDs are local execution requirements for Plans 07-52 through 07-56. They supplement the related roadmap IDs without changing `REQUIREMENTS.md` or claiming production completion.

| ID | Required outcome | Related roadmap requirement |
|---|---|---|
| DEV-GUI-01 | A browser creates or reconnects a disposable development Nostr identity, retains the private key client-side, and shows real relay/service/SQL/rail/worker/host connectivity. | OPS-01 |
| DEV-GUI-02 | The user funds the Nostr-linked application account through local Cashu or NWC over ContextVM/CEP-8 and sees the authoritative PostgreSQL balance and top-up state. | OPS-02 |
| DEV-GUI-03 | The user submits one bounded idea and an explicit maximum through ContextVM; the displayed required action ceiling prevents a below-reserve start. | SESS-02 |
| DEV-GUI-04 | The workspace shows persisted execution stage, safe errors, measured usage, actual spend, remaining balance/cap, and next action. | OPS-01 |
| DEV-GUI-05 | A verified immutable artifact opens through an opaque expiring grant in the official compatible host with `sandbox="allow-scripts"` and no same-origin authority. | OPS-04 |
| DEV-GUI-06 | Bounded revisions create inspectable immutable artifact versions while preserving prior versions and separately metering each action. | OPS-02 |
| DEV-GUI-07 | Insufficient funds produce a durable pending action and real checkpoint; after a real top-up, a signed explicit resume restores the checkpoint exactly once. | OPS-02, OPS-03 |
| DEV-GUI-08 | Publication uses the existing facade when concretely configured and otherwise shows `publication_unavailable` without simulated deployment, manifest, or attestation success. | OPS-04 |
| DEV-GUI-09 | One standalone command starts dependencies, migrations, credentials, service, compatible host, and GUI; stop retains state and reset explicitly removes development state. | OPS-03 |
| DEV-GUI-10 | Browser E2E proves funding → generation → preview → revision, pause/top-up/resume, duplicate submission, and application restart recovery across real local integration boundaries. | OPS-02, OPS-03 |
| DEV-GUI-11 | Deterministic mode is visibly identified and still produces source that passes the real worker/build/verify/conformance/preview path; a configured real provider follows the same accounting and artifact path and is labeled separately. | OPS-01, OPS-04 |
| DEV-GUI-12 | The responsive single-workspace UI meets the Phase 7 token, keyboard, focus, live-region, touch-target, key-custody, iframe, and owner-boundary contracts. | OPS-01, OPS-04 |
</requirements>

<decisions>
## Locked Development Decisions

- **D-141:** Browser application commands use installed `@contextvm/sdk@0.13.10` `NostrClientTransport` over the real local relay to server-side `NostrServerTransport` and `ContextVmSdkBridge`. Complete MCP lifecycle/tool dispatch in the bridge. A browser BFF or `DevelopmentContextVmTransport` may not call `ContextVmFundingAdapter` or a domain service directly for account, funding, generation, status, revision, resume, preview, or publication.
- **D-142:** The disposable user's Nostr secret is created and retained only in the browser. The server exposes only public bootstrap facts and retains service signing keys, rail credentials, database credentials, provider credentials, vault material, and cursor/receipt secrets. Tests must prove the user secret is absent from HTTP responses, bundles, logs, SQL, artifact/checkpoint stores, and server process configuration.
- **D-143:** HTTP is limited to static GUI assets, public bootstrap configuration, opaque expiring preview bytes, health/readiness, and an explicitly development-only loopback faucet/reconciliation seam when required. There is no HTTP application command endpoint. Every listener rejects non-loopback binding unless an explicit test harness uses an isolated container network.
- **D-144:** Cashu and NWC top-ups traverse the actual SDK payment-tag path and existing coordinators into PostgreSQL. A narrow browser client subclass may add per-request `pmi`, `payment_interaction`, and `direct_payment` tags through the SDK's protected `sendMcpMessage`; tags are invocation-local and never shared mutable client state. The UI displays the current runtime action ceiling and automated test funding must exceed the `code-proposal` reserve (currently 3,750 sat), rather than reusing the insufficient 1,024-sat example.
- **D-145:** Deterministic model mode substitutes only the external model. It writes a real source proposal into a server-owned action-bound proposal store and is visibly labeled `Deterministic fixture`. Configured provider mode uses a real `ModelGateway`, authoritative normalized usage, and the same proposal/worker path and is visibly labeled with an allowlisted provider name. Neither label may be inferred from success, and deterministic evidence never becomes a provider claim.
- **D-146:** Every generation and revision uses a real isolated local worker to scaffold through the promoted CLI/boilerplate, write only approved application surfaces, perform frozen installation, build, maintained verification, real-Chromium conformance, and dry-run deployment validation. Only the verified result may enter the immutable artifact repository or preview path; failure exposes bounded diagnostics.
- **D-147:** Preview uses the official compatible runtime adapter, with `@kehto/paja@0.19.0` sourced from a version/hash-pinned official napplet checkout or reviewed intake and Playwright Chromium `1.62.1`. The development image must explicitly support Apple Silicon hosts through a declared `linux/amd64` path or a verified native CLI path, install the pinned browser/system dependencies during image intake, and run build/preview runtime with default-deny network. A bare iframe, hand-written `srcDoc`, data URL, fake screenshot, or deterministic host response cannot be substituted for the compatible host; Paja's own verified internal `srcdoc` installation remains part of the official runtime and must be policy-tested rather than reimplemented.
- **D-148:** Fix the current early-affordability gap by creating a real durable pending-action checkpoint through the continuation authority and real worker/checkpoint ports before worker release. A top-up alone after checkpointing does not restart work; signed `resume_session` claims and restores the exact checkpoint and original pending action. Tests may advance an injected development clock, but may not fabricate a checkpoint or describe top-up-and-retry as resume.
- **D-149:** The GUI derives stages, usage, balances, versions, pending actions, and recovery states from durable application projections. Duplicate signed delivery/idempotency produces one credit/action/debit/build/version. Restart recovery reopens PostgreSQL and the immutable artifact/checkpoint stores and observes original operations rather than dispatching replacements.
- **D-150:** Publication presentation delegates to the existing ContextVM/publication facade. Without a configured real source, signer, upload, and relay graph, show the exact unavailable reason and no success identifiers. Development preview availability does not imply publication availability.
- **D-151:** `package.json` and `bun.lock` remain byte-identical to SHA-256 `cbcc433278d32391b075576ebd847ae30039f1d86ad229a149f5566856989f23` and `8916ee4ec92924ae9e09bc4f315fd6656033812696e35a1b7785161d872c5ac3`. Use a standalone Bun launcher, Bun's browser bundler, the reviewed toolchain lock, and a separate contained browser/host image. Do not add a root script or dependency. Launch does not depend on an unverified sibling checkout.
- **D-152:** The GUI is one practical responsive workspace: connectivity/identity and balance/funding; idea, maximum, and current action ceiling; execution timeline and safe errors; usage and remaining budget; version history; compatible-host preview; revision; continuation controls; and honest publication availability. It inherits the approved Phase 7 4px spacing scale, four type sizes/two weights, semantic host tokens, 44px target floor, responsive breakpoints, focus/dialog/live-region/motion rules, and exact owner-safe copy principles.
- **D-153:** `bun scripts/dev.ts up` automates payment dependencies, migrations, private development credentials, adequate test funding, pinned worker/host image intake, readiness, service start, and prints the GUI URL plus actionable redacted failures. `down` preserves PostgreSQL/artifact/checkpoint state; `reset` is explicit and scoped; `status` and `test` are non-secret-bearing. Normal restart preserves the disposable browser identity and service state.
- **D-154:** Production Plans 07-20 and 07-26, protected provider effects, release certification, promotion, and wider infrastructure claims are deferred and are never a prerequisite or dependency for Plans 07-52 through 07-56. Development records and UI copy must say `development` and must not complete `SESS-02` or `OPS-01`–`OPS-04`.
- **D-155:** Acceptance requires real browser/relay/SDK/SQL/rail/worker/build/conformance/compatible-host coverage. The final suite compares displayed balance/spend/version facts with persisted records, asserts duplicate and restart invariants, checks deterministic/provider labels, and proves secrets and direct authority do not cross browser, iframe, owner, or artifact boundaries.

## Verified Feasibility Facts

- `Bun.build()` successfully bundles the installed official browser client transport.
- A live encrypted SDK round trip through the local relay preserved the verified client pubkey and request event ID.
- A live encrypted ContextVM call through the existing adapter credited 64 sat by Cashu and 37 sat by NWC into SQL; Cashu replay did not duplicate the credit.
- The current bridge needs MCP `initialize`, `notifications/initialized`, `tools/list`, notification, and multi-metadata handling before it is a browser-ready server.
- NWC settlement observation is server-side and needs a bounded restart-aware development reconciler after invoice creation.
- The reviewed napplet source identifies `@kehto/paja@0.19.0` as its compatible host dependency. The existing sealed image has Playwright packages but not browser/system binaries and embeds an x86_64 CLI, so the development image must close both gaps explicitly.
- The reviewed npm intake for `@kehto/paja@0.19.0` has integrity `sha512-UCUwER9thz/sP3B1BPhM/QkymesjnFKGfeNLtuIX0lT1xPH+q8Tbl149U7P2OdgAWt+p5n8p/T/WIOXTFE1CBQ==`; official napplet conformance code starts it with `startPajaServer({ options: { host: '127.0.0.1', port: 0, targetUrl } })`, so no sibling checkout or hand-built runtime is required.
- A bounded Paja/Chromium feasibility probe completed with all optional capabilities false; relay/storage/cache/upload/sign/publish disabled; anonymous identity; ACL/firewall deny; generated iframe sandbox `allow-scripts`; opaque `null` origin; shell readiness and one interactive control; blocked parent storage and direct fetch; absent `window.nostr`; only the `shell` domain; and zero page errors. This proves the compatible-host policy is runnable, but it is not generated-artifact, worker, accounting, or publication evidence.

### the agent's Discretion

- Choose vanilla DOM module boundaries, exact CSS selectors, and the persisted client-key store, provided the identity never leaves the browser and the accessibility contract holds.
- Choose contained local artifact/checkpoint directory layout and opaque grant encoding, provided ownership, hash, expiry, containment, and restart checks are server-authoritative.
- Choose the actual configured model provider supported by existing `ModelGateway` contracts; keep configuration strict, opt-in, server-only, and separately labeled.
- Choose the test-only injected clock/control mechanism and exact adequate funding amount, provided it is isolated from normal runtime and exercises the same durable authorities.
</decisions>

<deferred>
## Deferred / Excluded

- Production provisioning, authorization, protected eight-suite certification, promotion, provider selection, live SLO certification, and Plans 07-20/07-26.
- Public HTTP, x402, L402, rich input, arbitrary website/backend generation, automatic cap increases/top-ups, automatic post-grace resume, and service custody of user keys.
- Simulated publication success, bare-iframe compatibility claims, synthetic ledger credits, mock SQL, fake checkpoints, fake browser passes, or replacing the ContextVM wire with a local direct-call transport.
</deferred>

---
*Development decisions D-141–D-155 are binding for Plans 07-52 through 07-56.*
