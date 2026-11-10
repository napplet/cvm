---
id: 261110-dtq
status: in_progress
---

# Decouple payment implementations from CVM

## Requested outcome

The public CVM owns accounts, exact credit accounting, signed spending limits,
admission and pause/resume. Operators own payment methods, payment verification,
currency conversion and credit sale prices through separately distributed adapters.
Multiple adapters and payment-free allowlisted operation must be supported.

Preserve existing balances, payment identities, audit history, projects and credentials.
Move the existing implementation to a private repository. Deploy that adapter to the
existing homelab workspace and service. Publish reviewable PRs and prove the complete
flow with end-to-end tests.

## Work

1. Map current funding readers/writers, deployment composition and test coverage.
2. Define the smallest generic adapter and credit boundary, with deterministic units,
   scoped idempotency, authenticated grants and explicit payment-free admission.
3. Extract existing payment implementation into a private repository, preserving
   wire behavior and existing database records; wire explicit runtime adapters.
4. Document human/agent adapter integration and test multiple methods, duplicate
   settlements, accounting, denied owners, free operation and pause/resume.
5. Run regression checks, open PRs, back up and deploy using operator-owned automation,
   and verify identity, state preservation and real runtime behavior.

## Forward path and rollback

Use additive interfaces and preserve existing persisted denomination values. Ship
the adapter alongside the new application revision. Back up each live database
before rollout. Roll back application and adapter together to their preceding
revisions. A pre-extraction application also requires an explicitly restored compatible snapshot because it rejects newer migration history. Do not drop payment tables, erase migration records, rewrite historical balances or rotate keys.

## Completion evidence

Record exact test results, public/private PRs and private deployment evidence in
the appropriate repositories. No completion claim until adapters are extracted,
end-to-end tests pass, and the existing homelab deployment uses the private adapter.
