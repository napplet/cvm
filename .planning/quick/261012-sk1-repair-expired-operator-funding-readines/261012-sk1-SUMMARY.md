---
task: 261012-sk1
status: complete
date: 2026-10-12
commit: a0156ce
---

# Funding readiness repair

Autonomous Phase 7 resumption reproduced RELEASE_AUTHORIZATION_OPERATOR_FUNDING_INVALID.
The persisted Cashu metadata was digest-valid but expired. Certification readiness
trusted the capture-time ready status and elevated it before authorization rejected
the expired rail. The local setup path also retained an obsolete two-rail gate.

## Changes

- Recheck expiry on certification projection and produce digest-valid expired
  status without changing stored metadata or extending reference validity.
- Keep invalid/revoked prerequisites from being elevated to certification-ready.
- Complete and close local setup after a fresh Cashu submission, preserving the
  optional NWC-first path and the separate dual-rail product prerequisite controller.
- Update local page instructions for the accepted Cashu-only certification policy.

## Verification

- Before repair: 5 new regression cases failed, 16 existing cases passed.
- Focused funding/authorization/preapproval coverage: 33 passed, 0 failed.
- Full repository suite with NAPPLET_CVM_TEST_EXTERNAL_EFFECTS=deny:
  677 passed, 0 failed, 5,177 assertions across 123 files.
- Real request retry: local_setup_required with all 18 external-effect counters zero.
- Diff review and whitespace checks passed.
- No wallet material read/printed, funding expiry renewed, receipt fabricated,
  protected result created, provider resource provisioned, or release promoted.

## Phase 7 continuation

Plan 07-20 remains incomplete. The local setup command opened the Cashu reconnection
page, which requires the operator's direct input and expires after ten minutes.
The user was asked to complete that page without sending wallet material in chat.

Independent inspection confirms the loaded certifier config is local and has no
protected execution configuration. The remaining deployment issue is integration,
not a user-authored configuration prerequisite:

- materializePreapproval has no production call site in src/ or scripts/.
- createProductionOperationalDependencies has no production call site.
- The pinned factory loader invokes createReleaseExecutionSession with only its
  factory input; the repository factory requires separately injected branded
  operational dependencies and reports AUTHORIZED_EXECUTION_PORTS_REQUIRED without them.

Wire controller-owned production composition and materialization through the
existing verification and receipt boundaries in a separate GSD gap fix; never
replace the dependency graph with fixtures or fabricate protected configuration.
Regenerate the exact bounded request after fresh funding and readiness, then obtain
the local structured approval before 07-26. Phase counts remain 49/51 and 89/91.
