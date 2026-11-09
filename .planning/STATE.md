---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: Safe Napplet Generation MVP
current_phase: 07
status: in_progress
stopped_at: provider-neutral service deployed to beta (test realm) via Ansible; paid generation and real-money rails await operator inputs
last_updated: "2026-11-01"
progress:
  total_phases: 7
  completed_phases: 6
  total_plans: 114
  completed_plans: 103
---
# Project State

Existing operator deployments may contain development/test credits. Preserve its identity, credentials, projects, artifacts and audit history. Production real-money operation is incomplete.

## Current instruction

Provider-neutral application. Simple container deployment using Ansible on an operator-selected host or VPS. Google Cloud is excluded. Reuse existing SQL/storage/model/worker/telemetry interfaces; configure adapters. No enterprise platform, cluster, separate provider graph or successor authorization scheme.

The non-google-v1 architecture and its native core/edge/host-preflight work are withdrawn. Former agent owners and handoffs are inactive and must not be resumed. The old Google production activation path remains disabled. See [deployment](../docs/architecture/provider-neutral-deployment.md).

Phase 7 remains unfinished (103/114 plans; 63/74 in Phase 7). Existing product safety, exact billing and isolated execution still apply. Do not claim production completion from this cleanup.

## Quick Tasks Completed

| Task | Result |
| --- | --- |
| 261031-vgz | Remove speculative infrastructure architecture and simplify affected mainline history; see quick-task summary. |
| 261101-pnd | Provider-neutral service composition, canonical migrations, gVisor worker engine, Ansible deployment, backup and isolated restore; live test-realm flow verified. See quick-task summary. |
| 261109-i83 | Container startup diagnostics and complete control-image packaging; focused regression and offline runtime probes. Hosted validation is tracked on PR #114. |

| 261109-j5i | Separate portable application deployment instructions from operator-owned inventories, automation and live records. |
