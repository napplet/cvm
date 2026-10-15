# Phase 7: Development Execution Gap - Research

**Researched:** 2026-10-15  
**Domain:** Local development composition for metered napplet generation  
**Confidence:** HIGH for current-code findings; MEDIUM for the proposed development composition

## User Constraints

- “Wire the GUI to real application services.” [VERIFIED: user request]
- “Preserve ContextVM as the public application transport; do not create a competing public HTTP generation API.” [VERIFIED: user request]
- “Deterministic model mode … must still execute the real orchestration, worker, build, verification, accounting, and preview paths.” [VERIFIED: user request]
- “Use real local services at integration boundaries” and never show simulated success. [VERIFIED: user request]
- Production deployment and certification are deferred, but existing production safeguards must remain intact. [VERIFIED: user request]

## Project Constraints (from AGENTS.md)

- Use the codebase-memory graph before text search for code discovery. [VERIFIED: AGENTS.md]
- Keep ContextVM as the only public v1 interface, retain transport-neutral generation/billing/session semantics, preserve spend caps and prepaid accounting, and use `@napplet/cli` rather than a replacement publication contract. [VERIFIED: AGENTS.md]
- Treat generated code, prompts, tool output, dependencies, and runtime messages as untrusted. [VERIFIED: AGENTS.md]
- Start implementation through a GSD workflow; this research changes no application source. [VERIFIED: AGENTS.md]

## Summary

The repository already has the financial and session authorities needed by a real local flow: Postgres-backed funding/metering, `MeteredGenerationService`, `ContinuationService`, real Cashu/NWC development funding, and a constrained Docker toolchain design. [VERIFIED: codebase graph and `src/phase-03/funded-core.ts`, `src/phase-04/metered-generation-service.ts`, `scripts/dev-payments.ts`, `infra/toolchain/Dockerfile`]

The missing work is not a GUI skin. There is no development composition that joins those authorities to a real local worker, persisted sealed-artifact store, compatible preview-byte host, or ContextVM-facing development transport. Existing deterministic workers/verifiers and Phase 6 preview ports are test doubles or descriptor-only seams. [VERIFIED: codebase graph and `src/worker-port/fake-worker.ts`, `tests/phase-06/fakes.ts`, `src/publication/preview-service.ts`]

**Primary recommendation:** Implement a development-only composition root and loopback-only GUI bridge that invokes the existing `ContextVmFundingAdapter`; pair it with a real Docker-local toolchain worker, a Postgres/filesystem sealed-artifact repository, and a byte-serving sandboxed preview host. Do not bypass metering, `ProjectNappletHarness`, or the ContextVM adapter. [MEDIUM: implementation inference grounded in current contracts]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|---|---|---|---|
| Disposable identity and GUI controls | Browser / Client | Frontend server | The browser retains its dev Nostr signer; the server receives a verified public identity only. [VERIFIED: AGENTS.md and `src/contextvm/adapter.ts`] |
| Generation admission, maximum and idempotency | API / Backend | Database / Storage | `MeteredGenerationService` validates commands and the funding store persists operation/budget fences. [VERIFIED: `src/phase-04/metered-generation-service.ts`, `src/persistence/funding-store.ts`] |
| Local Cashu/NWC funding | API / Backend | Database / Storage | `createDevelopmentFunding` creates real NWC/Cashu coordinators over local services and Postgres. [VERIFIED: `scripts/dev-funding.ts`, `scripts/dev-payments.ts`] |
| Real scaffold/build/verify/conformance | Local worker process | Database / Storage | The worker must execute a pinned Docker toolchain and persist only its verified result/evidence. [VERIFIED: `infra/toolchain/Dockerfile`, `src/phase-04/napplet-harness.ts`] |
| Revision history and session status | Database / Storage | API / Backend | Metered actions carry immutable result/artifact lineage and status reads are owner scoped. [VERIFIED: `src/persistence/funding-store.ts`, `src/phase-04/session-status.ts`] |
| Preview bytes and sandbox | Frontend server | Browser / Client | The server authorizes one verified artifact; the browser renders it in an iframe with `allow-scripts`. [VERIFIED: `src/publication/contracts.ts`, `src/publication/preview-service.ts`] |
| Pause/checkpoint/resume | API / Backend | Database / Storage / Local worker process | The continuation authority owns fences; its worker and checkpoint ports must perform the real export/restore. [VERIFIED: `src/continuity/continuation-service.ts`, `src/continuity/contracts.ts`] |

## Exact Existing Seams

### `MeteredGenerationService`

Construct it with:

```ts
new MeteredGenerationService({
  fundedAdmission,                 // same instance exposed through the core
  store: database.funding,         // PostgresSqlFundingStore
  gateway,                         // deterministic or configured live ModelGateway
  worker: localDockerWorker,       // real WorkerPort, not DeterministicFakeWorker
  artifactVerifier: localVerifier, // verifies real produced bytes/evidence
  harness: {
    runner: new ProjectNappletHarness({ worker: localDockerWorker, artifactVerifier: localVerifier }),
    toolchain: promotedLocalToolchainEvidence,
    snapshotReference: "dev:snapshot:initial",
    priorArtifactId: "dev:none",
    approvedApplicationSurfaces: ["src/App.tsx"],
  },
  continuation,
  continuationWake,
  telemetry,
});
```

The constructor requires `fundedAdmission`, a `MeteredFundingStore`, `ModelGateway`, `WorkerPort`, and `ArtifactVerifier`; the harness is optional in TypeScript but is the path that enforces the promoted workflow plus server-side artifact contract. [VERIFIED: `src/phase-04/metered-generation-service.ts:61`, `src/phase-04/napplet-harness.ts`]

`startSession` needs a principal, funded admission reference, idempotency key, `expectedVersion: 0`, maximum, policy version, and idea. `reviseSession` additionally needs the existing session ID and exact current version. [VERIFIED: `src/phase-04/metered-generation-service.ts:19-30`]

The currently selected `code-proposal` deterministic profile reserves **3,750 sat**: 1,000 input + 1,000 output + 250 cached + 1,000 reasoning. The GUI must either default to at least `3750` or retrieve/expose the runtime profile ceiling; a lower maximum is denied before provider/worker work. [VERIFIED: `src/model/price-card.ts`, `src/phase-04/metered-generation-service.ts]

### `ContinuationService`

Construct the continuation authority once over the same `database.continuationFunding`/funding authority, a real checkpoint store, and a real allocation adapter:

```ts
new ContinuationService({
  store: database.continuationFunding,
  resume: {
    compatibility: { policyVersion, profileId, priceCardId, toolchainId },
    checkpoint: localCheckpointRepository,
    allocate: localWorkerPool.allocateForResume,
  },
  telemetry,
});
```

Explicit resume requires `sessionId`, `checkpointId`, `expectedSessionVersion`, `expectedCheckpointVersion: 1`, an idempotency key, `approvePendingAction: true`, a cap approval reference, and the persisted pending-action reference/fingerprint/kind/maximum. [VERIFIED: `src/continuity/contracts.ts`, `src/continuity/continuation-service.ts`]

### `createFundedCore`

Use a `PostgresFundingDatabase` and provide its live development `lightning`, `cashu`, `capacity`, `transport`, `meteredService`, `continuationService`, `preview`, cursor secret, and admission-receipt secret. The factory intentionally refuses a public generation surface if those requirements are incomplete. [VERIFIED: `src/phase-03/funded-core.ts`]

The development GUI must use a loopback bridge that builds the same inbound ContextVM tool invocation and calls the configured adapter. It may expose a local-only browser BFF for display/session cookies, but it must not call `MeteredGenerationService` directly from a new general HTTP generation route. [MEDIUM: necessary integration design inferred from `createFundedCore` and the user constraint]

## Required Persistent Development State

| Store/table family | Existing content | Development addition needed |
|---|---|---|
| Phase 3 funding tables | Accounts, settlement credits, holds, budgets, idempotency, and outbox. [VERIFIED: `migrations/phase-03/001_funding.sql`] | Reuse unchanged. The GUI reads status through `AccountStatusService`, never a shadow balance table. [MEDIUM: architecture recommendation] |
| Phase 4 metering tables | Provider operation, normalized receipt, metered action result, versions, and artifact lineage. [VERIFIED: `migrations/phase-04/001_metered_generation.sql`] | Add a development artifact index keyed by `(account_id, session_id, artifact_id)` only if no existing row can retain sealed bytes and artifact identity. [MEDIUM: current metered lineage stores references, not artifact bytes] |
| Phase 5 continuation tables | Pause, wake dispatch, checkpoint, resume claim/restore observation, expiry/deletion state. [VERIFIED: `migrations/phase-05/001_continuation.sql`, `src/persistence/funding-store.ts`] | Reuse unchanged; add a local object directory/object metadata adapter that supplies the existing checkpoint port. [MEDIUM: composition recommendation] |
| Phase 6 publication tables | Publication command, intent, effect intent, and observations. [VERIFIED: `migrations/phase-06/001_publication.sql`] | Keep publication explicitly unavailable until a real dev publication adapter exists; persist a blocked reason instead of inventing a completed deployment. [MEDIUM: user constraint and existing fail-closed contract] |
| New dev-only schema | None exists. [VERIFIED: codebase search] | `development_artifacts` should store only ownership/version/identity/evidence references plus a contained local directory/object key; `development_preview_grants` should store one opaque grant, artifact ID, expiry, and consumed/revoked state. [MEDIUM: implementation recommendation] |

Use the existing migration runner in `scripts/dev-payments.ts`; it applies Phase 3–6 migrations with checksum protection and preserves normal state across `down`. [VERIFIED: `scripts/dev-payments.ts`]

## Real Local Toolchain Availability

| Dependency | Available | Evidence | Consequence |
|---|---|---|---|
| Bun | Yes, `1.3.14` | [VERIFIED: local probe] | Meets project engine requirement. |
| pnpm | Yes, `10.24.0` | [VERIFIED: local probe] | Matches the pinned sealed toolchain package manager. |
| Docker daemon/client | Yes, client `29.8.2`; `docker ps` succeeded | [VERIFIED: local probe] | Can run an isolated local build worker. |
| Local funding stack | Configuration and persisted local state exist; no containers were running during research | [VERIFIED: `.local/napplet-cvm-dev-payments/*`, local Docker probe] | `bun scripts/dev-payments.ts up` must be part of the launcher. |
| Playwright CLI | No global CLI found | [VERIFIED: local probe] | Run browser/conformance from the toolchain image or add a project-owned test runner; do not depend on a global executable. |
| Sealed toolchain image | Not present in the local Docker image list | [VERIFIED: local Docker probe] | The launcher must build/pull a reviewed image before generation. |
| Napplet source checkout | Present at `/Users/sandwich/Develop/napplet`, with package sources and `node_modules` | [VERIFIED: local filesystem probe] | Useful only as a development source/build input; it is not itself proof of a promoted runtime. |

The reviewed Dockerfile uses pinned Bun, frozen pnpm installs, a pinned standalone CLI, network-disabled runtime execution, a read-only root filesystem, dropped capabilities, unprivileged UID, bounded CPU/memory/PIDs, and an input-only mount. Reuse these controls for the local worker. [VERIFIED: `infra/toolchain/Dockerfile`, `infra/toolchain/egress-policy.json`, `src/runner/sealed-toolchain.ts`]

The existing fixture runner already executes the real `napplet create`, `init`, `skills install`, offline pnpm install, `build`, `verify`, `test:conformance`, and `napplet deploy --dry-run` command sequence. It is fixture-only and does not accept/generated user source, so it is an execution reference rather than the development worker. [VERIFIED: `infra/toolchain/fixture-runner.ts`]

## Development Composition Plan

1. **Create `src/dev/dev-composition.ts`.** Load only `.local/napplet-cvm-dev-payments/payments.json`, reject non-loopback endpoints, call `createDevelopmentFunding`, create `PostgresFundingDatabase`, and construct the single core/service graph. Keep all development checks in this module; production factories must not import it. [MEDIUM: implementation recommendation based on `scripts/dev-funding.ts`]
2. **Add a `DevelopmentContextVmTransport`.** It satisfies `ContextVmTransportPort`, captures the adapter response/notifications by local correlation ID, and accepts only locally authenticated dev-browser invocations. Route GUI actions through `ContextVmFundingAdapter.handle`, preserving schemas, owner derivation, idempotency, funding, and safe status projection. [MEDIUM: implementation recommendation based on `src/contextvm/adapter.ts`]
3. **Add a real `LocalDockerNappletWorker`.** Give it a per-action empty working directory; scaffold with the reviewed CLI; write only coordinator-approved application surfaces; run frozen install/build/verify/conformance/dry-run inside the Docker image; parse bounded JSON/evidence; hash and move output into the artifact repository. It implements `WorkerPort`, and it must never receive the Postgres URL, rail secrets, NWC URI, user signer, or host environment. [MEDIUM: implementation recommendation based on `WorkerPort`, `ProjectNappletHarness`, and the sealed runner]
4. **Use deterministic model output only as source proposal input.** `DeterministicModelGateway` can issue an actual normalized deterministic usage receipt, allowing real reserve/debit/finalization, but the worker must turn that proposal into real files and pass actual toolchain checks. Label it `deterministic_fixture`, exactly as its receipt specifies. [VERIFIED: `src/model/deterministic-model-gateway.ts`, `src/model/model-gateway.ts`, `src/model/price-card.ts`]
5. **Add a real `ArtifactVerifier` and sealed-artifact repository.** It must derive hashes and manifest/capability metadata from the Docker-produced `dist`, save immutable evidence, and return `undefined` on any failed verification. Do not reuse `passingVerifier` or `DeterministicSealedArtifactPort` outside tests. [VERIFIED: `src/phase-02/trusted-core.ts`, `tests/support/phase-04/session-artifact-probes.ts`, `tests/phase-06/fakes.ts`]
6. **Add a local preview byte host.** On a descriptor grant, serve only the matching immutable verified `dist` beneath an opaque expiring grant; render it with `<iframe sandbox="allow-scripts">`. The descriptor endpoint must not leak files by artifact path or allow arbitrary local directories. [MEDIUM: implementation recommendation constrained by `PreviewService` and `PreviewHostPort`]
7. **Make continuation honest.** Implement actual export/fence/restore/terminate adapters over the local worker and object directory; persist the envelope and checksums using Phase 5 contracts. Wire `continuationWake.continueAction` to resume the original stored operation only after the transaction claims it. [MEDIUM: implementation recommendation based on `src/continuity/continuation-service.ts`]
8. **Provide one launcher.** `bun scripts/dev.ts up` should: start/wait/migrate payments, build or verify the local toolchain image, initialize the development composition, start the local GUI/bridge, print its loopback URL, and redact all service credentials. `down` retains state; `reset` explicitly delegates to payment reset and deletes the dev artifact/checkpoint directory. [MEDIUM: implementation recommendation]

## Required GUI Data and States

| Screen concern | Read/write authority | Minimum data |
|---|---|---|
| Connectivity | Dev composition health probes | Dev identity pubkey fingerprint; relay, Postgres, Cashu/NWC, toolchain, and preview-host status. [MEDIUM: design recommendation] |
| Balance | `AccountStatusService` via ContextVM account status | Available/held sat and top-up history; never derive from browser state. [VERIFIED: `src/funding/account-status.ts`, `src/phase-03/funded-core.ts`] |
| Start | ContextVM `funded_admission` then `start_session` | Idea, maximum >= profile ceiling, policy version, unique idempotency key, admission reference. [VERIFIED: `src/contextvm/adapter.ts`, `src/phase-04/metered-generation-service.ts`] |
| Progress | Persisted action/status/evidence projection | Session/action/version, finite lifecycle stage, confirmed spend, remaining balance/cap, safe failure code. [VERIFIED: `src/phase-04/session-status.ts`, `src/telemetry/contracts.ts`] |
| Revision | ContextVM `revise_session` | Session ID, current verified version, revision text, maximum, new idempotency/admission reference. [VERIFIED: `src/phase-04/metered-generation-service.ts`] |
| Pause/resume | Continuation status and ContextVM `resume_session` | Pending reference/fingerprint/kind/maximum, real checkpoint ID/version, cap approval reference, explicit owner approval. [VERIFIED: `src/continuity/contracts.ts`, `src/contextvm/adapter.ts`] |
| Preview | `PreviewService` plus local grant handler | Artifact ID/version, aggregate hash, capability review, expiry, iframe sandbox. [VERIFIED: `src/publication/preview-service.ts`, `src/publication/contracts.ts`] |
| Publication | Existing publication facade only | Show `publication_unavailable` when no real adapter/source contract is configured. [VERIFIED: `src/contextvm/adapter.ts`, `src/phase-03/funded-core.ts`] |

## Actual Impossibilities vs. Missing Wiring

| Finding | Classification | Evidence | Required resolution |
|---|---|---|---|
| A working user-generated build/verifier path does not exist. | Missing wiring/implementation | The only real command sequence is fixture-bound; normal worker implementations are deterministic fake or Modal/Fly adapter shells. [VERIFIED: `infra/toolchain/fixture-runner.ts`, `src/worker-port/fake-worker.ts`, `src/worker-adapters/*.ts`] | Implement `LocalDockerNappletWorker` and a real verifier/repository. |
| The current preview service does not provide a URL or bytes to an iframe. | Missing wiring/contract extension | `PreviewHostPort.createDescriptor` returns only grant ID/sandbox/authority. [VERIFIED: `src/publication/contracts.ts`, `src/publication/preview-service.ts`] | Add a contained local grant-to-byte host; extend only dev-facing descriptor projection if a URL is needed. |
| The repository cannot honestly claim a “compatible sandboxed runtime” preview today. | Actual current limitation | Local compatible-host code is an injected port/evidence adapter; no concrete local reference-host/browser implementation was found. [VERIFIED: `src/release/native/compatible-host.ts`, `src/release/deployment/compatible-host-client.ts`, codebase search] | Integrate the official local reference host before labeling the preview compatible; until then label it sealed iframe preview only. |
| Insufficient-funds pause currently happens before model/worker execution and creates no checkpoint. | Actual semantic gap | `MeteredGenerationService.execute` calls `pauseForFunding` before budget/provider/worker execution, while explicit resume requires an existing checkpoint ID. [VERIFIED: `src/phase-04/metered-generation-service.ts`, `src/continuity/contracts.ts`] | Add a real live-worker/checkpoint lifecycle or define the early affordability result as top-up-and-retry, not checkpoint resume. Do not fake a checkpoint. |
| Automatic top-up wake has no supplied real `continuationWake.continueAction` coordinator. | Missing wiring | The service only invokes a caller-provided wake port after durable claim. [VERIFIED: `src/phase-04/metered-generation-service.ts`] | Implement it to reuse the original operation/action budget; no fresh provider charge or worker action. |
| Capacity reservation and `WorkerPort.run` have no shared lease parameter. | Actual production-boundary gap | `ReadyCapacityPort.reserveNow` returns an exact ready lease, but `WorkerRunRequest` has no lease/capacity identity. [VERIFIED: `src/funding/funded-admission.ts`, `src/phase-02/contracts.ts`] | Add a narrow coordinator-owned lease-to-worker binding before making any D-115 claim. A single-process dev pool may bridge it internally, but must not imply production proof. |
| Local package source and Docker are available; a locally tagged image is not a promoted immutable registry digest. | Actual production limitation, not a dev blocker | The sealed runner requires a SHA-256 repo digest; no toolchain image was present. [VERIFIED: `src/runner/sealed-toolchain.ts`, local Docker probe] | Use a separate explicit dev image identity/attestation; retain the existing sealed runner unchanged for promotion. |

## Don’t Hand-Roll

| Problem | Use | Reason |
|---|---|---|
| Ledger/reservation/idempotency | Existing funding store and `FundedAdmissionService` | They already preserve serializable money/state fences. [VERIFIED: `src/funding/funded-admission.ts`, `src/persistence/postgres-sql-funding-store.ts`] |
| Generation command validation | `ContextVmFundingAdapter` and existing schemas | Prevents the GUI from becoming a second authority/transport contract. [VERIFIED: `src/contextvm/adapter.ts`] |
| Napplet scaffold/build/conformance | Existing pinned Docker toolchain and upstream CLI workflow | Hand-writing a manifest or substituting a source-only bundle would evade the established checks. [VERIFIED: `infra/toolchain/Dockerfile`, `infra/toolchain/fixture-runner.ts`] |
| Capability review | `canonicalCapabilityReview` | The capability digest/compatibility result is a signed review boundary. [VERIFIED: `src/publication/capability-review.ts`] |
| Resume fencing | `ContinuationService` plus Phase 5 store contracts | A GUI retry loop cannot safely re-create checkpoint or resume identities. [VERIFIED: `src/continuity/continuation-service.ts`] |

## Validation Architecture

| Flow | Required proof |
|---|---|
| Funding → generation → preview | Start `dev-payments`; fund with real local Cashu/NWC; query persisted balance; invoke ContextVM adapter; verify Docker-produced `dist`; load an opaque preview grant in a browser. [MEDIUM: implementation test plan] |
| Revision | Create artifact v1, revise using expected version 1, confirm artifact v2 and unchanged v1 identity. [MEDIUM: implementation test plan] |
| Duplicate submission | Send same ContextVM invocation/idempotency key twice; assert one metered action/debit/worker build and replayed response. [MEDIUM: implementation test plan] |
| Pause/top-up/resume | Assert `needs_top_up`; top up through a real local rail; assert a real stored checkpoint before explicit resume; verify restored worker uses original action/budget identity. [MEDIUM: implementation test plan] |
| Restart recovery | Restart the GUI/composition process only; read Postgres and artifact/checkpoint stores; reconcile instead of rerunning an effect. [MEDIUM: implementation test plan] |

Run existing focused tests first: `bun test tests/phase-04 tests/phase-05 tests/phase-06 tests/funding`, then add a browser e2e command owned by the new dev launcher. [VERIFIED: `package.json`, existing test layout]

## Sources

- [VERIFIED: codebase graph] `napplet-cvm` architecture, `MeteredGenerationService`, `ContinuationService`, worker adapters, preview service, persistence, and release-host seams.
- [VERIFIED: repository source] `src/phase-03/funded-core.ts`, `src/phase-04/metered-generation-service.ts`, `src/phase-04/napplet-harness.ts`, `src/continuity/*`, `src/publication/*`, `scripts/dev-payments.ts`, `scripts/dev-funding.ts`, `infra/toolchain/*`.
- [VERIFIED: local environment] Bun 1.3.14, pnpm 10.24.0, Node 26.11.1, Deno 2.9.5, Docker 29.8.2; no global Playwright or existing toolchain image.

## Assumptions Log

| # | Claim | Risk if wrong |
|---|---|---|
| A1 | A loopback-only GUI bridge can be treated as a development control surface while all generation commands still traverse `ContextVmFundingAdapter`. [ASSUMED] | It might violate the product transport boundary; keep it local-only and test adapter invocation end to end. |
| A2 | A reviewed dev Docker image identity can support development evidence without satisfying production’s immutable registry-digest gate. [ASSUMED] | A weak identity boundary could be mistaken for a release artifact; mark every UI/evidence item development-only. |
| A3 | The local `/Users/sandwich/Develop/napplet` checkout can supply the official reference-host integration after its own build is verified. [ASSUMED] | It may not expose a usable host executable; then development preview remains an iframe-only preview and must be labeled accordingly. |

## Planning Order

1. Composition root plus local ContextVM GUI bridge and health/readiness reporting.
2. Real local toolchain worker, artifact verifier/repository, then one generation-to-preview e2e.
3. Revision and persisted status/evidence projections.
4. Continuation lifecycle implementation; do not schedule the pause/resume e2e until a real checkpoint exists.
5. Publication presentation only through the existing facade, with unavailable state retained until a real adapter is configured.
