# Verification: payment adapter extraction

Verified 2026-11-10. Runtime application revision:
`9f2a1fa1a0238e73ad292b3282a6d1b20dda9714`.

| Acceptance | Evidence |
| --- | --- |
| Generic credit boundary | Public signed ContextVM / adapter / free-access tests: 11 pass. Scoped grants, replay conflicts, concurrency, rounding, overflow and cleanup covered. |
| Multiple payment adapters | Registry discovers installed methods, routes by method ID, rejects duplicate IDs and sanitizes payment output. Browser selector uses descriptors. |
| Free mode | Signed allowlisted admission succeeds without a payment module; unlisted or invalid requests cannot mint credits; normal holds and signed limits apply. |
| Existing implementation private | Provider code, Cashu dependency, rails and dependent suites extracted. Repository visibility verified private; adapter PR open. |
| Payment regressions | Private default suite: 108 pass, 3 skipped, 0 fail. |
| Real isolated end-to-end | `bun scripts/dev-payments.ts test` in the adapter repository: **167 pass, 1 skipped, 0 fail**. Real Cashu/NWC bootstrap, payments, restart, module load, worker generation and pre-admission resume covered. Test stacks cleaned up normally. |
| Persistence | Actual PostgreSQL suite: 5 pass, 0 fail. Canonical upgrade, retained rows, scoped concurrent grants, restart, realm isolation and immutable usage checked. |
| Compilation | Both application and adapter TypeScript projects pass. |
| Portable/private packaging | Operator tests: 9 pass. Exact committed revisions, no untracked secret export, source preservation, old composition and downgrade refusal covered. |
| Existing homelab works | Signed discovery, real private-adapter funding, bounded real ChatGPT generation, interactive verified remote preview and reopen pass. Service key and existing artifact identity preserved. Exact records remain in the operator repository. |
| Additional service rollout | Healthy schema/containers, same service key, signed Lightning and Cashu payments and replay pass. Its full generation flow is blocked by configured OpenAI credential HTTP 401; rejected operation spent zero. |
| Documentation/review | Human/agent adapter guide, free/multiple methods, exact pricing, migration and rollback documented; public PR #115 open, stacked on #114. |

## Broad regression limits

One root-wide run returned 961 pass, 13 skip and seven failures under heavy
concurrency. The affected relay/socket and expensive proof-gate files passed
isolated reruns. Proof-gate reruns used `--timeout 60000`; no production timeout
or protection rule changed. This is not a claim of a clean simultaneous default
root-wide run. The original detached revision also has pre-existing fixture and
external-effect-policy failures.

Immutable OTel approval files were not renewed or rewritten. Tests pin the
historical manifests in an explicit fixture and confirm the changed dependency
root remains unapproved. Historical production/certification fixtures are retained
separately with the operator implementation; this work does not activate withdrawn
infrastructure or certify real-money production.

The existing user-owned untracked `deno.lock` is preserved. Test-generated
transient tracked changes and the abandoned proof-test directory were removed.
