# Current infrastructure direction

Provider-neutral application. Simple Ansible/container deployment to the existing homelab or a VPS. Google Cloud is excluded. Do not invent a separate "non-Google" graph, authorization schema, parallel runtime, cluster, or custom storage service. Reuse existing interfaces and configure their adapters. Latest user direction supersedes older Google selections and enterprise topology plans. See `.planning/phases/07-admission-slo-resilience-launch-safety/07-NO-GOOGLE-CLOUD-DECISION.md`.

## Code discovery

Prefer codebase-memory MCP graph tools (`search_graph`, `trace_path`, `get_code_snippet`, `query_graph`, `get_architecture`). Use `rg` for non-code/configuration, literals, or insufficient graph results.

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
- **Infrastructure**: Provider-neutral adapters; container deployment through Ansible on homelab or a VPS. Reuse the existing Coolify service. Google Cloud is excluded. Keep infrastructure simple.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

TypeScript and Bun; PostgreSQL for transactional persistence; existing model, object-storage and worker ports; ContextVM over Nostr; pinned napplet CLI/SDK/Chromium. Configure provider adapters at bootstrap. Use ordinary container deployment with existing Coolify or Ansible on a homelab/VPS. See `docs/architecture/provider-neutral-deployment.md`.
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
