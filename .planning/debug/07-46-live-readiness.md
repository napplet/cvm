---
status: resolved
trigger: "Live readiness defects discovered immediately after completed Plan 07-46: product request is blocked by missing authoritative live price catalog and protected execution config; factory method remains a stub; controller lacks a local setup path for generated protected config, opaque NWC/Cashu locators, and structured approval."
created: 2026-08-06T20:00:00Z
updated: 2026-08-06T21:00:00Z
---

# Debug Session: 07-46 live readiness

## Symptoms

- **Expected:** `bun run release:certify -- --candidate toolchains/candidates/initial.json --request` becomes truthfully ready to advance Plan 07-20 through a controller-owned local setup, or returns only concrete unavoidable local official wallet/approval UI actions. Users never hand-author protected config/evidence or paste secrets/digests.
- **Actual:** The command returns `preapproval_blocked` with `RELEASE_CONTROLLER_LIVE_PRICE_CATALOG_REQUIRED` and `RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED`, plus NWC/Cashu readiness blockers. `src/release/deployment/production-factory.ts` still throws `PRODUCTION_FACTORY_EXECUTION_PORTS_REQUIRED` from `prepareAuthorizedExecution()`. The CLI accepts only candidate/resume/dry-run/status/request/receipt, so no controller-launched local setup exists.
- **Errors:** `RELEASE_CONTROLLER_LIVE_PRICE_CATALOG_REQUIRED`; `RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED`; `PRODUCTION_FACTORY_EXECUTION_PORTS_REQUIRED`.
- **Timeline:** Discovered immediately after Plan 07-46 completed; the prior fixture-price/product-request issue was resolved separately.
- **Reproduction:** Run `bun run release:certify -- --candidate toolchains/candidates/initial.json --request`; inspect `prepareAuthorizedExecution()`.

## Current Focus

- **bug_class:** Bohrbug (deterministic blocked product request from a fixed command/environment)
- **hypothesis:** Plan 07-46's materializer/factory composition was only partially implemented: `materializeProtectedCertifier` can generate a pinned config given a receipt and references, but the product request has no preapproval bootstrap to supply those inputs, and `production-factory` provides no authorized-execution implementation.
- **test:** Inspect the production-catalog and preapproval source adapters for an existing way to create source-attributed facts without provider effects, then contrast that with the local secret-locator contract.
- **expecting:** An existing production source adapter would permit a narrow CLI composition fix; if none exists, the block is a missing implementation, not a hidden runtime setting.
- **next_action:** Append a corrective execution plan for the missing live adapters and controller-owned local setup before Plan 07-20.

## Evidence

- timestamp: 2026-08-06T20:05:00Z
  checked: Repository worktree and release symbol search
  found: The only pre-existing untracked paths are the debug session, research cache, deno.lock, and evidence/design files named in the task. The requested failures resolve to scripts/certify-release.ts, src/release/controller.ts, src/release/production-execution.ts, and src/release/deployment/production-factory.ts, with focused tests already present.
  implication: Preserve all listed untracked files; the defect is localized to release-readiness composition rather than an unrelated worktree change.

- timestamp: 2026-08-06T20:08:00Z
  checked: Release CLI, deployment factory, execution-loader interface, certification configuration guidance, and focused test declarations
  found: The CLI allowlist has no setup option and treats both --request and --receipt as dry runs. Missing current pricing produces only a redacted preapproval_blocked projection. The production factory's prepareAuthorizedExecution always throws PRODUCTION_FACTORY_EXECUTION_PORTS_REQUIRED; its provider methods reject effects before approval. The documentation nonetheless says the controller creates digest-pinned material and that users do not author protected config.
  implication: The observed behavior is a deterministic composition/ownership gap: no existing public path can create controller-owned protected readiness material, and the factory cannot proceed beyond that input boundary.

- timestamp: 2026-08-06T20:14:00Z
  checked: Plan 07-46, the materializer, factory seam, and operator-funding prerequisite controller
  found: Plan 07-46 explicitly requires a controller-generated config, a factory that constructs the complete registry and eight real protected ports, and a request that reaches review after safe discovery. The materializer can write candidate-bound pinned artifacts but requires an already-valid receipt and caller-supplied secret references. `operator-funding.ts` exposes only an in-memory opaque `os-secret-ref:` capture controller and has no CLI persistence/setup owner. The production factory is limited to a native discovery registry and an unconditional preparation stub.
  implication: The shipped code violates the plan's completion contract in two independent code paths: preapproval setup/config materialization is unreachable, and receipt-bound execution is unimplemented. Environment credentials cannot make this command ready.

- timestamp: 2026-08-06T20:19:00Z
  checked: Prior live-path diagnosis, Plan 07-45 boundary, and focused current request test with NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny
  found: The existing test passes because it intentionally asserts the defective `preapproval_blocked` response. The prior fix explicitly deferred completion until an all-family catalog, protected factory, and two funding locators existed. Plan 07-45 permits only local secret-locator metadata and read-only official catalog access, while Plan 07-46 requires that ready state to be controller-generated before review.
  implication: This is a coverage gap, not a flaky runtime: current tests encode the fail-closed fallback but lack a specified test for the permitted local readiness setup path.

- timestamp: 2026-08-06T20:24:00Z
  checked: Deployment client constructors, protected-port entrypoints, production catalog exports, and factory composition seam
  found: The individual client constructors are safe construction-time descriptors, but several require injected operational ports or loopback-only transports; none is called by production-factory. The only factory runtime instead installs a native registry whose plan/apply/observe/cleanup always reject, and no production code calls `createProductionLiveCostCatalog`. Funding capture allows `os-secret-ref:` locator names, while payment descriptors require `nwc:`/`cashu:` references, so locator capture is not composed into any execution path.
  implication: A simple environment/configuration addition cannot cure readiness. The factory, locator representation, cost catalog, and CLI must be composed through an explicit no-effect preapproval layer; post-authorization execution must remain guarded until concrete operational ports exist.

- timestamp: 2026-08-06T20:30:00Z
  checked: Authorization lifecycle, Plan 07-20 checkpoint contract, native registry, and controller execution path
  found: A request's `expectedReceiptSha256` is explicitly not approval authority; a structured receipt contains approval principal/channel/funding-readiness and a different `authorizationReceiptSha256`. The materializer is called only inside `executeAuthorized`, after `validateAuthorizationReceipt`, so its required receipt binding cannot generate the claimed preapproval configuration. Plan 07-20 explicitly relies on a controller-launched local NWC/Cashu surface but owns no code changes, while factory configuration remains unavailable before that checkpoint.
  implication: The defect is an invalid ordering boundary, not merely a missing environment variable. Any fix must create a distinct preapproval configuration/readiness artifact without treating an expected digest as a receipt or weakening the later exact receipt validation.

- timestamp: 2026-08-06T20:35:00Z
  checked: Native-provider and protected-port constructor inventories
  found: Native provider factories require specific authorized control-plane ports, and all eight protected-port shapes require concrete operations marked `evidenceClass: real`; only generic test fakes currently assemble them. The production factory invokes neither set. A false production port cannot be safely synthesized from an opaque secret locator because it would make the post-receipt execution branch appear real while lacking a provider-backed operation.
  implication: The receipt-bound stub is a genuine missing operational composition, not a harmless placeholder. The preapproval fix must neither report it ready nor replace it with fixtures; it requires a separate factory capability model.

- timestamp: 2026-08-06T20:39:00Z
  checked: Git history and the three Plan 07-46 commits
  found: `production-factory.ts` was first introduced by `f7ec05f`, already with the unconditional execution-port stub. No older production factory exists to restore. The same commit added execution pins only inside the post-receipt materializer; `59f8069` merely made readiness instantiate that incomplete session. The generated config's `releaseReadiness` flags all report `true`, so current readiness is able to claim a fully operational factory despite the unimplemented method.
  implication: This is a shipped completeness/false-readiness defect introduced with the initial Plan 07-46 implementation. A repair must make readiness reflect executable capabilities and establish a separately pinned preapproval configuration path.

## Eliminated

## Resolution

- The false-positive factory readiness claim is removed. Even with every opaque secret reference present, readiness now reports `AUTHORIZED_EXECUTION_PORTS_REQUIRED`, and the production session cannot be constructed until a real receipt-gated runtime is supplied.
- Regression coverage now proves that a complete inventory and locator set are not equivalent to executable provider/suite readiness.
- The missing production catalog caller, controller-owned preapproval materialization, local NWC/Cashu setup surface, and concrete authorized runtime are implementation work rather than environment setup. They must be completed before asking the operator for wallet interaction or approval.
