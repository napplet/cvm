---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: Safe Napplet Generation MVP
current_phase: 7
current_phase_name: Admission SLO, Resilience & Launch Safety
status: executing
stopped_at: Phase 7 AI-SPEC complete; research next
last_updated: "2026-08-05T15:26:31.499Z"
last_activity: 2026-08-05
last_activity_desc: Phase 6 complete, transitioned to Phase 7
progress:
  total_phases: 7
  completed_phases: 6
  total_plans: 51
  completed_plans: 40
  percent: 86
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-08-04)

**Core value:** A user can describe one focused applet and receive a safe, conformant napplet that can be previewed and placed directly into a compatible napplet runtime.
**Active milestone:** v1.0 — Safe Napplet Generation MVP
**Current focus:** Phase 7 — Admission SLO, Resilience & Launch Safety

## Current Position

Phase: 7 — Admission SLO, Resilience & Launch Safety
Plan: Not started
Status: Ready to execute
Last activity: 2026-08-05 — Phase 6 complete, transitioned to Phase 7

Progress: [██████████] 100%

## Milestone Progress

**v1.0 — Safe Napplet Generation MVP**

- Phases: Phases 1–6 verified complete; Phase 7 is active at discussion (6/7, 86%).
- Plans: 40/40 currently known milestone plans executed; Phase 7 plans remain to be created.
- Requirements: 54/54 v1 requirements assigned; 49 verified complete and 5 Phase 7 requirements pending.
- Next checkpoint: smart-discuss Phase 7, then research and plan its admission SLO, resilience, live certification, and launch-safety work without revisiting completed Phases 1–6.

## Performance Metrics

**Velocity:**

- Total plans completed: 40
- Average duration: -
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 | 6 | - | - |
| 2 | 6 | - | - |
| 3 | 7 | - | - |
| 04 | 7 | - | - |
| 05 | 7 | - | - |
| 6 | 7 | - | - |

**Recent Trend:**

- Last 5 plans: -
- Trend: Not enough data

**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 01-napplet-contract-artifact-verification P01 | 5 min | 2 tasks | 10 files |
| Phase 01 P02 | 5 min | 2 tasks | 5 files |
| Phase 01 P03 | 7 min | 1 tasks | 5 files |
| Phase 01 P04 | 99 min | 2 tasks | 12 files |
| Phase 01 P05 | 25m | 2 tasks | 12 files |
| Phase 01 P06 | 45m | 3 tasks | 14 files |
| Phase 02 P01 | 6m 15s | 1 tasks | 7 files |
| Phase 02-trusted-core-isolated-agent-execution P04 | 5m 11s | 2 tasks | 6 files |
| Phase 02 P05 | 6m 19s | 2 tasks | 7 files |
| Phase 02 P06 | 17m | 3 tasks | 11 files |
| Phase 03 P07 | 15m | 3 tasks | 8 files |
| Phase 04 P01 | 5m | 2 tasks | 6 files |
| Phase 04-metered-generation-revision-loop P02 | 24m | 2 tasks | 9 files |
| Phase 04-metered-generation-revision-loop P03 | 8m 21s | 2 tasks | 8 files |
| Phase 04 P04 | 14m | 3 tasks | 9 files |
| Phase 04 P05 | 8m | 2 tasks | 8 files |
| Phase 04 P06 | 34m 37s | 2 tasks | 7 files |
| Phase 04 P07 | 28m | 3 tasks | 6 files |
| Phase 05 P01 | 6 min | 2 tasks | 7 files |
| Phase 05 P02 | 6 min | 2 tasks | 7 files |
| Phase 05 P03 | 538s | 2 tasks | 7 files |
| Phase 05 P04 | 10 min | 2 tasks | 5 files |
| Phase 05 P05 | 306s | 2 tasks | 8 files |
| Phase 05 P06 | 7 min | 2 tasks | 8 files |
| Phase 05 P07 | 12 min | 2 tasks | 8 files |
| Phase 06 P01 | 5m 11s | 1 tasks | 5 files |
| Phase 06-sealed-preview-user-owned-publication P02 | 38m 22s | 2 tasks | 8 files |
| Phase 06 P03 | 9m 26s | 3 tasks | 11 files |
| Phase 06 P04 | 9 min | 2 tasks | 6 files |
| Phase 06 P05 | 8m 27s | 3 tasks | 14 files |
| Phase 06-sealed-preview-user-owned-publication P06 | 13m | 2 tasks | 6 files |
| Phase 06 P07 | 13m | 2 tasks | 7 files |

## Accumulated Context

### Decisions

Recent decisions affecting current work:

- Phases preserve trust dependencies: napplet verification and worker containment precede funded generation.
- ContextVM is the sole v1 public adapter; x402/L402 remain v2 ports only.
- Publication is user-owned manifest signing plus separate CVM attestation; the CVM never holds user private keys.
- Five-second admission and worker-vendor choice are validation gates, not assumptions.
- [Phase ?]: Promotion tracer successes are review-ready only; no promoted-pointer mutation path exists.
- [Phase ?]: Hermetic runner uses manifest-pinned absolute argv with explicit minimal environment and content-addressed evidence.
- [Phase ?]: Candidate identity canonicalizes package metadata while preserving strict stage order.
- [Phase ?]: Initial candidate remains unverified until exact CLI, package, image, fixture, and NAP evidence is proven.
- [Phase ?]: Candidate CI is read-only and emits only immutable candidate/evidence outputs.
- [Phase ?]: Pre-install approval authorizes only sealed candidate intake/testing; it cannot promote or mutate the current pointer.
- [Phase ?]: D-04 PromotionManifest pins remain mandatory at promotion while the intake review records only source provenance.
- [Phase ?]: @napplet/sdk@0.27.2 uses an explicit official release-commit mapping because no matching Git tag exists.
- [Phase ?]: Sealed image receives only integrity-checked intake artifacts; final runtime has no package resolver or npx fallback.
- [Phase ?]: Every promotion runs explicit DNS, HTTP, HTTPS, and TCP denial probes through runSealedToolchain before stages.
- [Phase ?]: BuildKit provenance is disabled for deterministic local image digest identity.
- [Phase ?]: Phase 01 fixture treats unavailable sealed native scaffold execution as structured blocked evidence; compatible self-contained scaffold closure is deferred to Phase 7.
- [Phase ?]: Phase 1 design evidence records blocked native fixture execution explicitly; launch-grade native/Chromium closure remains Phase 7 work.
- [Phase ?]: All initial Phase 2 ceilings reside in the deeply immutable phase-02-policy-2026-08-04 fixture.
- [Phase ?]: Workers return strict proposals only; the coordinator derives grants, mediates the single workspace write, and owns results, versioning, and evidence.
- [Phase ?]: The serialized in-memory store is explicitly a copy-then-commit tracer double; Plan 03 replaces it with durable SQLite composition.
- [Phase ?]: Worker tool authority is a closed grant-bound union with validation-before-effect mediation and replay-safe results.
- [Phase ?]: The deterministic WorkerPort fake proves isolated proposal and checkpoint boundaries without claiming Bun Worker security isolation.
- [Phase ?]: Modal passes establish candidate eligibility only; provider selection, production certification, and SLO claims remain deferred.
- [Phase ?]: Modal SDK loading is deferred until strict provider configuration validation, preserving offline blocked evidence without provider construction.
- [Phase ?]: Modal sandbox resource and timeout ceilings derive exclusively from PHASE_02_POLICY_INITIAL.
- [Phase ?]: Final Phase 2 reference composition requires explicit SQLite; the memory store is test injection only.
- [Phase ?]: Offline design readiness is provider-separated: blocked/failed remain unselected and a pass is only eligible-not-selected.
- [Phase ?]: Phase 3 design readiness is offline deterministic proof; all live provider observations remain blocked and unselected until Phase 7.
- [Phase ?]: Phase 3 reference evidence fixes D-40 through D-58 to result, durable-state, external-effect, and redacted-evidence oracles.
- [Phase ?]: The deterministic Phase 4 provider fixture remains unselected; metering proof does not select or certify a live provider.
- [Phase ?]: Receipt settlement prices only a persisted action-time fixture card/profile using bigint rational arithmetic.
- [Phase ?]: Both PostgreSQL adapters expose the same metered authority while SQL retains the sole production transaction boundary.
- [Phase ?]: Finalization replays the stored terminal action when receipt identity and charge match, never creating a second debit.
- [Phase ?]: Ambiguous dispatches persist usage_unknown and reconcile only through the original provider operation.
- [Phase ?]: Late authoritative receipts settle as failed actions when artifact completion is unknown; definitive non-acceptance charges zero.
- [Phase ?]: Revisions serialize per account/session before new provider or worker work and reuse the established action receipt lifecycle.
- [Phase ?]: Only the ProjectNappletHarness verified branch may advance an artifact; non-passing outcomes retain the prior artifact and return redacted diagnostics.
- [Phase ?]: Automatic repair is one owner-scoped, persisted action per originating failed action; subsequent recovery requires a signed revision.
- [Phase ?]: Status cursors are versioned HMAC envelopes bound to account, session, page size, and underlying resume position.
- [Phase ?]: ContextVM returns only explicitly allowlisted metered action fields; account identity and protected provider material never cross the adapter boundary.
- [Phase ?]: Repair remains coordinator-internal; the public generation surface is exactly start_session, revise_session, and session_status.
- [Phase ?]: Phase 4 evidence gate keeps deterministic gateway unselected and live model not observed pending Phase 7 certification.
- [Phase ?]: Twenty actual authority cases with exact effect signatures are the Phase 4 design evidence release gate.
- [Phase ?]: Runtime scenarios receive boundedInput, initialState, and schedule only; expected values remain comparator-only.
- [Phase ?]: Unaffordable actions pause in the serialized funding authority before any action-budget authorization.
- [Phase ?]: Funding and approved-cap shortfalls remain separate bigint-derived canonical decimal values.
- [Phase ?]: Continuation status uses an explicit owner-safe allowlist rather than spreading durable records.
- [Phase ?]: Checkpoint identity and live-lease revocation commit together in the continuation authority.
- [Phase ?]: Explicit resume claims are replay-safe and terminally fenced at the fixed 30-day retention deadline.
- [Phase ?]: Continuation is exposed as the existing PostgreSQL funding authority, not a separate repository.
- [Phase ?]: Checkpoint manifests use canonical authenticated metadata plus independent archive and object digests.
- [Phase ?]: Continuation worker lifecycle contracts are coordinator lease-bound and exclude provider authority.
- [Phase ?]: Payment and relay signals remain non-authoritative; durable funding and the exact pause/version/lease tuple are required for a fresh wake budget.
- [Phase ?]: Checkpoint promotion is object-first but SQL-authoritative, with live lease revocation committed before worker termination.
- [Phase ?]: Resume compares durable server-owned action and compatibility pins before any budget, allocation, or restore effect.
- [Phase ?]: ContextVM resume_session derives its principal only from verifiedClientPubkey and returns a safe allowlisted result.
- [Phase ?]: Retention expiry is server-authoritative at checkpointCommittedAtMs plus 30 days; tombstone wins before exact key/object cleanup and cannot be revived.
- [Phase ?]: Expired continuation status is owner-safe and terminal, exposing no resume or top-up transition.
- [Phase ?]: Phase 5 reference probes retain expected durable/effect values as comparator-only facts.
- [Phase ?]: Phase 5 deterministic evidence remains provider-separated; live certification stays Phase 7 work.
- [Phase ?]: Preview grants are allow-scripts-only exact-artifact read descriptors.
- [Phase ?]: Publication effects are persist-before-effect and terminal results require three stored observations.
- [Phase ?]: Preview host responses are deny-by-default; only expected grant/context fields are allowed.
- [Phase ?]: Capability approval hashes canonical manifest facts plus artifact, d-tag, policy, toolchain, and runtime fences.
- [Phase ?]: Publication intent IDs derive from complete canonical approval fingerprints; runtime compatibility remains bound by the capability digest.
- [Phase ?]: Only nostr-tools/pure serialization, hash, and signature verification APIs enter production; owner signing remains external.
- [Phase ?]: Publication commands must bind the durable intent fingerprint and all child operation IDs before any external effect.
- [Phase ?]: Publication effects use one stable durable operation identity and unknown observations remain reconciliation-pending.
- [Phase ?]: Publication availability remains fail-closed until the exact promoted CLI source checkout and pinned source hashes verify.
- [Phase ?]: Publication reconciliation observes only durable original operation ids; linked completion requires upload, owner relay, and attestation evidence.
- [Phase ?]: Publication is invocable only with both a configured facade and an available Plan 05 source contract; otherwise it returns publication_unavailable without effects.
- [Phase ?]: The host surface is a pure strict owner-safe rendering projection with no dashboard, signer, or transport authority.
- [Phase ?]: Phase 6 design evidence accepts deterministic authority and source-contract proof only; live host, signer, CLI asset, relay, Blossom, PostgreSQL/Cockroach, and provider records remain not_observed under Phase 7 ownership.
- [Phase ?]: Phase 6 evidence hashes canonical payload bytes and requires complete mapping coverage before atomically updating its content-addressed pointer.

### Pending Todos

- Execute the seven checker-approved Phase 6 plans, beginning with the end-to-end tracer in Plan 06-01.

### Blockers/Concerns

- No active Phase 1 blocker. Official `@napplet/cli@0.5.2` plus matching `@napplet/skills`/`@napplet/boilerplate@0.3.2` is recorded as review-ready candidate `a19fc7d283a4482c53728f4a931743576564fb3826d7f8fa1383d02578b69024` and was explicitly approved for design execution.
- Exhaustive toolchain provenance, cross-environment reproducibility, full hostile/mutation coverage, formal golden approval, waiver exercises, SBOM/provenance enforcement, and production promotion are intentionally deferred to Phase 7.
- Future phases must contract-test evolving ContextVM/CEP-8 wire details, model exact-usage receipts, signing-runtime behavior, and the five-second SLO under load.

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Adapter | Public x402 and L402 interfaces | v2 | 2026-08-03 |
| Input | Images, files, URLs, repositories, and existing code | Deferred pending separate controls | 2026-08-03 |
| Collaboration | Multi-principal sessions | v2 | 2026-08-03 |

## Session Continuity

Last session: 2026-08-05T11:53:32.704Z
Stopped at: Phase 7 AI-SPEC complete; research next
Resume file: .planning/phases/07-admission-slo-resilience-launch-safety/07-AI-SPEC.md
