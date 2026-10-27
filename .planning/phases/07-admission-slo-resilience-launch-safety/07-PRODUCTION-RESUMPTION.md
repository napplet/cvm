# Production resumption scope — 2026-10-27

The following user request resumes the production deferral. Historical summaries remain unchanged; production readiness remains unproven.

Close the gap between the working private homelab CVM and a verified production service.

Repositories:
- CVM: ~/Develop/napplet-cvm
- Homelab: ~/Develop/homelab

The CVM already runs on Beta through Coolify using an existing ChatGPT account and test credits. Real generation, isolated builds, HTTPS previews, signed ContextVM requests, and restart recovery have passed.

Prefer upgrading this deployment in place. Preserve credentials, identities, projects, artifacts, and audit history. Use a separate deployment only where a demonstrated isolation, availability, or migration requirement justifies it.

Test credits must never become spendable production funds. Establish an explicit boundary between test and real-money accounting; this does not inherently require separate servers, applications, or databases.

This request resumes previously deferred production-readiness work. It does not authorize unlimited spending, unrestricted public exposure, or unbounded real-money transfers.

1. Establish the actual gaps

Read AGENTS.md in both repositories, .planning/STATE.md, the Phase 7 requirements and plans, and:
- docs/runbooks/production-readiness-deferred.md
- docs/runbooks/release-certification.md
- .planning/phases/07-admission-slo-resilience-launch-safety/07-EXECUTION-BLOCKERS.md
- The completed private homelab deployment summary
- The current homelab CVM runbook and deployment definitions

Follow repository code-discovery instructions. Verify findings against current code and live infrastructure rather than treating plans or previous summaries as proof.

Start through $gsd-plan-phase 7 --gaps. Produce a concrete gap matrix linking each requirement to its implementation, missing work, and required completion evidence. Execute the resulting plans; do not stop after planning.

2. Resolve production architecture without unnecessary replacement

Reuse the existing homelab infrastructure, Coolify lifecycle, service configuration, and operator commands wherever they meet production requirements.

Identify conflicts between the current deployment and the approved database, checkpoint storage, worker isolation, availability, and recovery requirements. Recommend the smallest justified changes and document architectural decisions before substituting a different authority or provider.

Do not silently replace required durable services with development equivalents, claim high availability from a single host, or treat the privileged nested Docker engine as a certified production sandbox.

Prepare an explicit migration and rollback sequence. Preserve the working service during preparation. Before cutover, back up affected state, verify restoration, and safely quiesce or checkpoint active work.

3. Complete the real production composition

Implement the application call sites for preapproval materialization and production operational dependencies. Construct the complete required provider graph and real protected-suite adapters.

Replace loopback-only or injected transport placeholders with authenticated operational transports, durable operation identities, observation/reconciliation, and bounded cleanup. Removing loopback restrictions alone is insufficient.

Production configuration must disable development faucets, FakeWallet payments, fixture-model fallbacks, synthetic billing, and development keys by construction. Keep administration private and authenticated.

Preserve ContextVM over Nostr as the public generation interface. HTTP may serve approved static assets, artifacts, previews, and operational surfaces; do not introduce a public HTTP generation API.

4. Make funding, billing, and provider usage production-safe

Preserve the existing ChatGPT credentials securely, but do not silently turn synthetic ChatGPT development rates into production prices.

Select and verify a production-appropriate provider and billing arrangement against the product contract, actual usage evidence, current authoritative documentation, and source-attributed pricing.

Implement and verify real CEP-8 Lightning and Cashu funding, transactional crediting, reservations, exact settlement, and immutable receipts. Enforce funded balances and user-approved caps across concurrency, cancellation, retries, and crashes.

Close the documented treasury gaps:
- Durable custody and recovery of received Cashu proofs.
- Ownership evidence for outputs after ambiguous swaps.
- Protection against re-encoded spent-token attempts.
- Recovery when an NWC invoice-creation response is lost before its payment hash is persisted.
- Query-only reconciliation of uncertain outcomes, without blind reissue, redispatch, or duplicate credit.

Preserve test-accounting history while ensuring test balances cannot authorize real-money spending. Explain and verify the chosen accounting boundary.

5. Prove isolation, durability, and publication

Use an approved production worker boundary with enforced filesystem, network, resource, lifetime, and capability restrictions. Generated code must never receive provider credentials, database access, service signing keys, or user signing keys.

Verify checkpoint encryption, retention, explicit resume, lease recovery, and the required live-worker grace period. Exercise backups and restoration into a fresh instance, not merely a restart of the original container.

Preserve pinned napplet tooling, real Chromium conformance, verified artifacts, and CLI-based publication. Verify user-owned signing through the supported signer boundary. The CVM must never receive the user’s Nostr private key.

6. Complete release certification honestly

Produce fresh, real, candidate-bound evidence for all eight required suites:
- admission
- telemetry
- chaos
- restore
- security-host
- supply-chain
- contextvm-payment-model
- publication

Meet the exact locked acceptance thresholds, including admission sample counts, forced cohorts, the five-second p95 requirement, and zero accepted backlog.

Do not weaken gates, skip failing checks, substitute fixture observations for live evidence, or count the private deployment’s smoke tests as production certification.

Repair relevant CI prerequisites and architecture failures. Classify unrelated failures accurately and explain their release impact. Required unresolved checks must remain release-blocking.

7. Make authorization the final preparation step

Complete everything possible without live authorization first: implementation, tests, measured candidate/configuration material, provider scopes, cost estimates, effect inventory, migration, retention, cleanup, and rollback.

Then present the exact controller-issued bounded authorization request. Request only genuinely missing official login, consent, signing, or approval steps.

Do not ask me to invent a trust bundle, hand-author provider configuration, paste credentials into chat, or manufacture evidence.

Do not execute protected effects until the exact authorization receipt validates. If the candidate, topology, scope, cost envelope, or authorization changes or expires, obtain matching authorization.

After approval, execute the protected path, reconcile interruptions using original operation identities, run the sole release evaluator, verify the immutable release bundle, and confirm required cleanup.

8. Deliver a reproducible production service

Expose normal deployment, certification, status, verification, backup, restore, and rollback operations through stable root ./homelab commands.

Commit the configuration and runbooks needed to recreate the service. Keep secret values outside Git. Follow branch, PR, and merge policies, and ensure live infrastructure is backed by merged mainline configuration.

Enable public traffic and real-money operation only after the production gates pass and the approved cutover conditions are satisfied.

Completion means the actual production service is deployed and verified against every requirement—not merely implemented, container-healthy, or passing a smoke test.

Finish with:
- Production endpoints and operator commands.
- Exact deployed revisions and release evidence.
- Funding, billing, isolation, publication, and recovery results.
- How existing data and test-accounting history were preserved.
- Backup and rollback instructions.
- Actual authorized costs.
- Any remaining blockers, without claiming completion.

Work autonomously until these conditions are satisfied or a genuine external dependency requires my action. Do not create a separate deployment merely as a default precaution.

## Initial current-state observations

- CVM main and latest finished Coolify deployment: `24252f744b8cd5f33a216c264a658623b98b7a42`; deployment `yzuxxcgg9g5li8pk4umujulp`, finished 2026-10-27T12:03:11Z.
- `./homelab cvm inspect`, `runtime`, and `verify` passed read-only checks: existing app healthy, signed WSS service key `715bd434527b8e1fd73201bb48ec9b91444229250798c4bbc1c24c32320e4bbf`, provider `ChatGPT subscription · local test sats`. No generation was dispatched.
- Newer graph project `Users-sandwich-Develop-napplet-cvm` traces only test callers for `materializePreapproval` and `createProductionOperationalDependencies`. Homelab has no graph index.
- Production refusal tests: 18 passed, 90 assertions; this proves refusal behavior only.
- `release:certify -- --candidate toolchains/candidates/initial.json --request` exits 1 with `local_setup_required`, all reported effect counters zero. This is not a reviewable production authorization request.
- CI payment run `40498472843`: 19 failures and one error, missing shared payment config, Playwright and worker prerequisites, plus stale migration assertion. GUI run `40498472848`: ARM runner reports AMD64 relay not running. Both remain unresolved.
- Pre-existing untracked research caches, design evidence, `.playwright-mcp/`, and `deno.lock` are outside this task and must be preserved.
