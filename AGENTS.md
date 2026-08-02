<!-- GSD:project-start source:PROJECT.md -->

## Project

**napplet-cvm**

napplet-cvm is a ContextVM-accessible generation service that turns a bounded text idea into a small, single-purpose, conformant Nostr web applet (a napplet). A user funds a Nostr-linked account, runs an iterative metered agent session, previews the generated napplet inside a real sandboxed runtime, and publishes verified deployment files plus a user-owned napplet manifest and CVM build attestation.

The generation core is transport-neutral. ContextVM over Nostr is the only external interface in v1, with CEP-8 used for account top-ups; future adapters may expose the same core through x402 and L402 without changing generation, billing, or session semantics.

**Core Value:** A user can describe one focused applet and receive a safe, conformant napplet that can be previewed and placed directly into a compatible napplet runtime.

### Constraints

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
- **Infrastructure**: Avoid AWS where practical; prefer rapidly starting, usage-metered compute with multi-region/high-availability options.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## Recommendation

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| TypeScript | 5.9.x, pinned | Single language for ContextVM adapter, domain core, policy, worker harness, and tests | ContextVM, Modal, and napplet tooling all expose TypeScript/JavaScript APIs. Share a transport-neutral `GenerationService` interface between ContextVM now and x402/L402 adapters later. |
| Bun | >=1.2.0, image-pinned | Control-plane runtime in a small Cloud Run container | `@contextvm/sdk@0.13.10` declares Bun >=1.2.0. Bun keeps the Nostr/MCP adapter on the runtime the SDK currently advertises; pin a container digest after interoperability tests, not a floating tag. |
| Google Cloud Run (second generation) | Managed service, min instances = 3 per primary region | Always-ready ContextVM/Nostr ingress, authenticated coordinator API, and reconciliation workers | Non-AWS, container-native, bills in 100 ms increments, and supports always-warm minimum instances. Cloud Run documents three minimum instances as a high-availability baseline; it is a control plane only, not the user-visible build container. |
| Cloudflare DNS + Load Balancing | Managed | Global health-checked routing to two active control-plane regions | Keeps Nostr adapter recovery independent of one regional ingress. Multiple replicas will receive duplicate relay events; event IDs and database uniqueness are mandatory. Do not use a Cloudflare Worker as the only ContextVM host until the SDK's Bun/WebSocket behaviour on Workers is explicitly certified. |
| CockroachDB Cloud Dedicated on GCP, PostgreSQL-wire compatible | Managed, pin provider major at provisioning | Multi-region strongly transactional accounts, reservation ledger, sessions, leases, idempotency keys, and transactional outbox | A metered service needs serializable accounting and regional fault tolerance, not a scale-to-zero database. Use the default serializable transaction mode and an append-only debit/reservation ledger. For a lower-cost launch, use Cloud SQL for PostgreSQL 17 HA in one region, but treat cross-region database continuity as a later milestone. |
| Google Cloud Storage dual-region bucket | Managed | Immutable checkpoint archives, verified artifacts, validation evidence, and attestation payloads | Versioned objects plus database object generation/checksum make a checkpoint resumable after a worker dies. Keep only encrypted archives for 30 days; deletion is a scheduled, auditable lifecycle action. |
| Modal JavaScript SDK | `modal@0.9.0` | Provision, inspect, communicate with, and terminate isolated agent/build Sandboxes | Official JS SDK supports Sandboxes, per-Sandbox CPU/memory limits, command timeouts, filesystem access, snapshots, and restricted outbound networking. Use a prebuilt immutable image and warm pool; billable worker activity is per second. |
| Modal Sandboxes | Managed, API current as of research | Per-session isolated workspaces for `@napplet/skills`, scaffold, build, browser conformance, preview bundle creation, and `@napplet/cli` publication preparation | Designed specifically for executing untrusted/user or agent-generated code. Set low default CPU/memory reservations with hard ceilings, max lifetime, explicit idle timeout, no inbound ports, and `blockNetwork: true` except during a narrowly-scoped allowlisted tool phase. |

### Protocol and Product Packages

| Library / protocol | Verified version | Purpose | Required usage |
|--------------------|------------------|---------|----------------|
| `@contextvm/sdk` | `0.13.10` (npm latest) | ContextVM MCP-over-Nostr server/client implementation and CEP-8 payment integration | Place in a thin `ContextVmAdapter` only. Convert signed event identity into the domain `Principal`; validate every protocol message before invoking the core. CEP-8 handles top-up capability discovery/settlement, while the service's internal prepaid ledger charges exact usage. |
| CEP-8 | Experimental/living ContextVM enhancement | Payment negotiation for a separate Lightning/Cashu top-up capability | Use its current prepaid/subscription pattern: verify and credit a top-up in one ledger transaction, then waive the generation-call price only after a reservation succeeds. Version-test against the official paid-server fixture before release. |
| `@napplet/skills` | `0.3.1` (npm latest) | Agent authoring contract | Install into the image/project before any coding turn. Require the `make-napplet`, `design-napplet`, `build-napplet`, and `test-napplet` flows; treat skill text as policy guidance, not a security boundary. |
| `@napplet/boilerplate` | `0.3.1` (npm latest) | Authoritative project substrate | Scaffold with the CLI workflow, then permit edits only to application surfaces. Preserve its package-manager pin, scripts, Vite config, and conformance wiring. |
| `@napplet/sdk` | `0.27.2` (npm latest) | Typed shell-mediated NAP calls in generated napplets | Generated code uses SDK imports, never direct `fetch`, browser storage, signer, relay, cookie, or `window.nostr` access. Required capabilities must be declared; optional capabilities are presence-checked at runtime. |
| `@napplet/vite-plugin` | `0.14.1` (npm latest) | Build-time NIP-5A manifest hash generation | Preserve boilerplate configuration. Use its generated file/aggregate hash as one input to server-side attestation, not as a substitute for server-side verification. |
| `@napplet/conformance-cli` | `0.2.18` (npm latest) | Real-Chromium conformance gate | Run `pnpm verify` and `pnpm test:conformance` in every build/revision before preview and before publication. Store the exact command, lockfile hash, output digest, and browser report. |
| NIP-5D / NIP-5A | Living protocol; `@napplet/core@0.31.1` reports protocol `4.0.0` | Sandbox, manifest, and typed NAP boundary | Version-pin the complete napplet toolchain as a compatibility set; conformance fixtures, not hand-coded manifest logic, determine acceptance. |
| `hono` | `4.12.33` | Narrow Cloud Run admin/coordinator HTTP endpoints | Use only for health, internal coordinator, and operator surfaces. It must not leak a public HTTP generation API in v1. |
| `zod` | `4.4.3` | Boundary schemas | Validate ContextVM payloads after SDK decoding, generated tool requests, worker reports, payment callbacks, and persisted checkpoint metadata. |
| `kysely` + `pg` | `0.29.4` + `8.22.0` | Typed SQL and PostgreSQL-wire transactions | Keep money/lease SQL explicit: `SERIALIZABLE` transaction, conditional balance update, unique idempotency key, immutable ledger row, and outbox row together. Avoid an ORM that obscures retry/error handling. |

### Execution Contract

### Supporting Libraries and Tools

| Library / tool | Version | Purpose | When to use |
|----------------|---------|---------|-------------|
| `pnpm` | Corepack-pinned in boilerplate image | Hermetic installation and frozen lockfile builds | Every generated project; reject absent or modified lockfile unless the approved build action explicitly changed dependencies. |
| Playwright Chromium | Boilerplate/conformance pinned | Actual sandbox runtime validation | Run only inside the build Sandbox; its report is a publish precondition. |
| OpenTelemetry JS | Pin during implementation | Traces/metrics for admission, sandbox-ready latency, ledger, and publish outbox | Emit `accepted_to_sandbox_ready_ms` and separate pool-hit/pool-miss histograms. The five-second SLO cannot be inferred from vendor marketing. |
| Modal filesystem snapshots | GA filesystem snapshots; **memory snapshots Alpha** | Optional fast restore/base image optimization | Filesystem snapshots may accelerate restore but are not the source of truth. Do not use memory snapshots in a correctness path. |
| Modal domain outbound allowlist | **Beta** | Limit a temporary model/API tool phase | Prefer full `blockNetwork` for build/test and a proxy-mediated egress design. Do not make beta domain filtering the only exfiltration defense. |

## Platform Comparison

| Platform | Start / isolation / billing evidence | Fit for v1 | Decision |
|----------|--------------------------------------|------------|----------|
| **Modal Sandboxes** | Secure arbitrary-code containers, JS API, boot in seconds, warm-pool example, resource limits, snapshots, network controls, per-second Sandbox billing | Directly maps to an interactive isolated workspace and predictable resource caps | **Primary worker plane.** Maintain ready inventory to meet p95; test availability in chosen regions and keep a vendor exit interface. |
| Runpod Serverless | FlashBoot marketed as sub-200 ms, Flex/Active worker options, network storage, global GPU regions, per-second billing | Excellent for a self-hosted model or GPU inference endpoint; its endpoint/handler model is not an agent workspace/orchestrator | **Secondary model-compute option only.** Use behind a model-provider adapter if hosted/open-weight inference becomes necessary. |
| Cloudflare Containers | Any-language containers paired with Workers; scale-to-zero; 10 ms active billing | Attractive future colocated preview/control compute, but newer platform and no documented readiness SLO for adversarial build workloads | **Do not use as v1 build Sandbox.** Keep for a later evaluated alternative. |
| Fly Machines | Fast-launching VMs, API lifecycle, volume support, suspend/resume, regional placement | Viable portable control plane or eventual second sandbox implementation; docs call placement best-effort and do not offer the needed readiness guarantee | **Control-plane fallback, not primary worker.** Use if Cloud Run/Modal integration cannot meet measured SLO. |
| Northflank | Multi-region CPU/GPU services/jobs, autoscaling, per-second pro-rating, managed platform | Strong option for a conventional multi-region service or managed Kubernetes estate | **Not v1 worker.** No primary-source evidence of five-second ephemeral isolated workspace readiness. |
| Cloud Run alone | Containers scale to zero, 100 ms billing; instances/filesystems are disposable and request startup can pend | Good for warm, stateless Bun control plane; not a per-session untrusted code isolation product | **Use for control plane only.** Set min instances; do not rely on its pending-request behavior to disguise a queue. |

## Installation and Image Construction

# control plane

# deterministic napplet build image

### Mandatory napplet CLI preflight

## Alternatives Considered

| Recommended | Alternative | When to use alternative |
|-------------|-------------|-------------------------|
| Modal Sandbox worker pool | Runpod Serverless | When v2 hosts an open-weight model and needs cost-efficient GPU inference; keep the workspace itself on Modal. |
| Cloud Run warm Bun replicas | Fly Machines | When persistent relay sockets, regional placement, or container control makes a VM-style runtime operationally simpler; deploy at least two Machines and retain the same database idempotency design. |
| CockroachDB Cloud Dedicated on GCP | Cloud SQL PostgreSQL 17 HA | Use Cloud SQL for lower-cost single-region v1 if an AZ failure is the availability target. Add a disaster-recovery plan before promising regional failover. |
| Explicit Postgres state machine + leases | Temporal | Only for non-admission reconciliation work. Temporal's task queues are incompatible with the product promise that accepted work starts immediately or is rejected. |

## What NOT to Use

| Avoid | Why | Use instead |
|-------|-----|-------------|
| A durable request queue for generation admission | It turns accepted work into delayed work, violates the immediate-start contract, and complicates spend/lease ordering | Capacity reservation + warm-pool claim; reject overload before accepting funds or work. |
| One long-lived mutable worker per user/session | A crash loses state and idle ten-minute workers leak cost; it also defeats horizontal recovery | Live worker for the short window, durable GCS checkpoint after every boundary, explicit lease-based reattach/resume. |
| Modal memory snapshots as checkpoints | Officially Alpha and limited; copying process memory is not a financial or publication transaction boundary | App-owned tar/zstd workspace export plus JSON state/evidence in immutable object storage and committed metadata. |
| Cloudflare Containers or Cloud Run as the primary untrusted build environment | They provide containers but no verified p95-ready isolated-workspace contract for this workload | Modal Sandbox warm pool with explicit ready health checks and resource/network policy. |
| Serverless scale-to-zero database or KV as the monetary source of truth | Ledger correctness needs serializable multi-row transactions, exact conditional debit, and durable idempotency | HA SQL ledger plus append-only entries and transaction outbox. |
| `@napplet/*@latest`, hand-written NIP-5D/NIP-5A manifests, or bypassing the CLI | The ecosystem is alpha and registry/docs topology currently differs; manual protocol duplication will drift | Pinned successful compatibility set, upstream scaffold/CLI, and real Chromium conformance. |
| Giving the sandbox Nostr keys, database access, unrestricted egress, or cloud credentials | Generated code and tool output are untrusted; credentials convert a code-generation defect into account compromise | Capability-brokered coordinator APIs, short-lived session credentials, no inbound ports, full network block by default. |

## Version Compatibility and Acceptance Gates

| Component | Compatible with | Required check |
|-----------|-----------------|----------------|
| `@contextvm/sdk@0.13.10` | Bun >=1.2.0 according to its npm engine metadata | Run signed ContextVM invoke, CEP-8 Lightning top-up, Cashu top-up, prepaid price-waive, replay, and reconnect fixtures against a real relay. |
| `@napplet/skills@0.3.1` + boilerplate `0.3.1` | Package pair from the `napplet/napplet` repository | Install into a disposable generated project and retain the resulting managed skill block/hash. |
| `@napplet/sdk@0.27.2` + Vite plugin `0.14.1` + conformance CLI `0.2.18` | **Unverified as a release set** because registry source/revision information differs across packages | Gate image promotion on authoritative scaffold's `verify` and real-Chromium `test:conformance`; publish only a dry-run verified artifact. |
| Modal `0.9.0` Sandbox API | Prebuilt image digest and pool manager | Load test pool-hit start, pool-miss start, failover/reclaim, checkpoint export/import, and enforce p95 `< 5 s` from funded acceptance to Sandbox-ready. |
| Cloud Run + multi-region SQL | Two independently healthy ingress regions | Chaos-test duplicate relay delivery, worker loss during debit/publish, database retry, regional ingress loss, and resume at 9:59 vs. 10:01. |

## Sources

- [ContextVM documentation](https://docs.contextvm.org/) and [CEP-8 announcement/links to specification](https://nostr.com/nevent1qqs0gp6dqkc0xctltl63mlrjn6nyrudtylgs79gjnsmlfy7569xug4qzyp4n0q8099eww0fhpwz28eg70256ud9lgy5n3h8mm8zlvwezzstvsptych2) — ContextVM over Nostr and current CEP-8 release details. **MEDIUM**: official but experimental, and context7 was unavailable.
- npm registry metadata for [`@contextvm/sdk`](https://www.npmjs.com/package/@contextvm/sdk), [`@napplet/skills`](https://www.npmjs.com/package/@napplet/skills), [`@napplet/sdk`](https://www.npmjs.com/package/@napplet/sdk), [`@napplet/cli`](https://www.npmjs.com/package/@napplet/cli), and [`modal`](https://www.npmjs.com/package/modal) — exact latest tags/repositories inspected on 2026-08-03. **HIGH** for registry metadata.
- [napplet package overview](https://napplet.run/), [skills package docs](https://jsr.io/@napplet/skills), [NIP-5D guide](https://napplet.run/docs/guide/nip-5d.html), and [conformance package docs](https://jsr.io/@napplet/conformance) — scaffold/skills/CLI/conformance contract and alpha status. **MEDIUM** because package versions are moving.
- [Modal Sandboxes](https://modal.com/docs/guide/sandboxes), [JavaScript Sandbox API](https://modal.com/docs/sdk/js/latest/Sandbox), [networking/security](https://modal.com/docs/guide/sandbox-networking), [snapshots](https://modal.com/docs/guide/sandbox-snapshots), and [Sandbox pricing/resources](https://modal.com/docs/guide/sandbox-resources) — sandbox capabilities, billing, and experimental statuses. **HIGH** for documented capability; **MEDIUM** for meeting the product SLO until benchmarked.
- [Cloud Run minimum instances](https://docs.cloud.google.com/run/docs/configuring/min-instances), [Cloud Storage bucket locations](https://docs.cloud.google.com/storage/docs/bucket-locations), [Cloud Storage object versioning](https://docs.cloud.google.com/storage/docs/object-versioning), and [Cloudflare Load Balancing monitors](https://developers.cloudflare.com/load-balancing/monitors/) — warm control-plane floor, dual-region checkpoint storage, and health-checked routing. **HIGH** for documented features.
- [CockroachDB data resilience](https://www.cockroachlabs.com/docs/stable/data-resilience/), [multi-region capabilities](https://www.cockroachlabs.com/docs/stable/multiregion-overview), and [serializable transactions](https://www.cockroachlabs.com/docs/stable/demo-serializable) — replicated multi-active data and default serializability. **HIGH** for database semantics; provisioned-service edition/region availability must be confirmed commercially.
- [Runpod Serverless](https://www.runpod.io/product/serverless), [Runpod pricing](https://www.runpod.io/pricing), [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/), [Fly Machines](https://fly.io/docs/machines/overview/), [Northflank pricing](https://northflank.com/pricing), and [Cloud Run overview](https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run) — platform comparison. **MEDIUM**: vendor primary sources; no cross-vendor benchmark was performed.

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `$gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `$gsd-debug` for investigation and bug fixing
- `$gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `$gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
