---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: Safe Napplet Generation MVP
current_phase: 4
current_phase_name: Metered Generation & Revision Loop
status: planning
stopped_at: Phase 3 complete; ready to discuss Phase 4
last_updated: "2026-08-04T17:58:46.771Z"
last_activity: 2026-08-04
last_activity_desc: Phase 3 complete, transitioned to Phase 4
progress:
  total_phases: 7
  completed_phases: 3
  total_plans: 19
  completed_plans: 19
  percent: 43
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-08-04)

**Core value:** A user can describe one focused applet and receive a safe, conformant napplet that can be previewed and placed directly into a compatible napplet runtime.
**Active milestone:** v1.0 — Safe Napplet Generation MVP
**Current focus:** Phase 03 — ContextVM Funding & Funded Admission

## Current Position

Phase: 4 — Metered Generation & Revision Loop
Plan: Not started
Status: Ready to plan
Last activity: 2026-08-04 — Phase 3 complete, transitioned to Phase 4

Progress: [███░░░░░░░] 43% of milestone phases complete; Phases 1–3 verified, Phase 4 ready for discussion

## Milestone Progress

**v1.0 — Safe Napplet Generation MVP**

- Phases: Phases 1–3 complete; Phase 4 is active and ready for discussion; Phases 5–7 remain.
- Plans: 19/19 currently known milestone plans executed; Phase 4 plans have not yet been created.
- Requirements: 54/54 v1 requirements assigned; 25 verified complete and 29 pending.
- Next checkpoint: discuss Phase 4 Metered Generation & Revision Loop, then research, specify, plan, and execute it without revisiting completed Phases 1–3.

## Performance Metrics

**Velocity:**

- Total plans completed: 19
- Average duration: -
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 | 6 | - | - |
| 2 | 6 | - | - |
| 3 | 7 | - | - |

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

### Pending Todos

- Discuss and plan Phase 4 Metered Generation & Revision Loop from the completed Phase 3 funding authority.

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

Last session: 2026-08-04T16:31:20.587Z
Stopped at: Completed 03-07-PLAN.md
Resume file: None
