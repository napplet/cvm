---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: Safe Napplet Generation MVP
current_phase: 07
status: in_progress
stopped_at: infrastructure detour removed; provider-neutral application wiring remains
last_updated: "2026-10-31"
progress:
  total_phases: 7
  completed_phases: 6
  total_plans: 114
  completed_plans: 103
---
# Project State

The existing private CVM runs on homelab Beta/Coolify with development/test credits. Preserve its identity, credentials, projects, artifacts and audit history. Production real-money operation is incomplete.

## Current instruction

Provider-neutral application. Simple container deployment using Ansible on homelab or VPS, or the existing Coolify lifecycle. Google Cloud is excluded. Reuse existing SQL/storage/model/worker/telemetry interfaces; configure adapters. No enterprise platform, cluster, separate provider graph or successor authorization scheme.

The non-google-v1 architecture and its native core/edge/host-preflight work are withdrawn. Former agent owners and handoffs are inactive and must not be resumed. The old Google production activation path remains disabled. See [deployment](../docs/architecture/provider-neutral-deployment.md).

Phase 7 remains unfinished (103/114 plans; 63/74 in Phase 7). Existing product safety, exact billing and isolated execution still apply. Do not claim production completion from this cleanup.

## Quick Tasks Completed

| Task | Result |
| --- | --- |
| 261031-vgz | Remove speculative infrastructure architecture and simplify affected mainline history; see quick-task summary. |
