# Pitfalls Research

**Domain:** Metered ContextVM service that generates, validates, and publishes NIP-5D napplets
**Researched:** 2026-08-03
**Confidence:** MEDIUM — primary protocol/vendor documentation was checked, but NIP-5D and CEP-8 remain experimental and require version-pinned contract tests.

## Critical Pitfalls

### Pitfall 1: Treating a napplet as a small web app instead of an untrusted sandbox guest

**What goes wrong:** The generator emits `fetch`, `WebSocket`, browser storage, `window.nostr`, external assets, or a permissive iframe. The preview works in a developer browser but violates NIP-5D, bypasses shell consent, or exfiltrates data when run by a real host.

**Why it happens:** A coding model and ordinary front-end scaffold default to browser APIs. Developers use `allow-same-origin`, origin checking, or a mock runtime as a convenience and mistake it for the protocol boundary.

**How to avoid:** Make a capability allowlist the artifact contract: only the authoritative scaffold, `@napplet/sdk`, declared NAP domains, local bundled files, and a literal `sandbox="allow-scripts"` iframe. Parse the built output and reject forbidden APIs/imports/URLs. In the shell, bind every inbound message to the registered `MessageEvent.source` and its `(d-tag, aggregate-hash)` identity; do not trust `event.origin` from the opaque sandbox. Require graceful degradation for undeclared or unavailable NAPs.

**Warning signs:** Generated `package.json` includes generic Nostr/browser packages; `dist` contains external URLs; static scans find `fetch(`, `WebSocket`, `localStorage`, `window.nostr`, `document.cookie`, or `allow-same-origin`; preview only works in an unsandboxed development iframe.

**Verification approach:** Run a real Chromium conformance suite against each build, including forbidden-API fixtures and spoofed `postMessage` senders. Assert that only the intended NAP request shapes reach the shell and that an absent capability produces a safe UI state. Store the report keyed by aggregate hash.

**Phase to address:** Phase 1 — napplet contract, scaffold, static policy, and real-runtime conformance foundation.

---

### Pitfall 2: Relying on prompt wording or a jailbreak classifier to authorize agent actions

**What goes wrong:** A text idea or revision persuades the model to reveal tools/system prompts, read another session, install a package, use shell/network access, alter the cap, or create a non-napplet. A detector misses a variant and the agent has enough authority to make the miss harmful.

**Why it happens:** Prompt injection has no complete lexical solution; natural-language instructions and untrusted content share a model context. Code-generation harnesses often turn model text into tool commands or treat generated test output as trusted feedback.

**How to avoid:** Accept bounded text only, retain raw input separately from instructions, and use detection/rate limits as signals rather than permission. Give the model a fixed, typed tool surface: write only inside a fresh workspace; no arbitrary command construction; no account/ledger/publication tool; no cross-session reads; no credentials. A deterministic policy engine independently validates every tool request, artifact, capability declaration, and state transition. Redact secrets from context and logs; abort/review on high-risk injection signals without losing the durable safe checkpoint.

**Warning signs:** Tool calls contain prompt fragments, encoded commands, paths outside workspace, new install commands, or references to previous users; unusually long output; repeated policy denials; model attempts to alter manifests or billing state.

**Verification approach:** Maintain an adversarial corpus of direct and indirect jailbreaks, encoded payloads, malicious compiler/test output, and cross-session probes. Demonstrate that each is either rejected or contained without filesystem/network/ledger side effects. Audit tool-call traces rather than judging only final prose.

**Phase to address:** Phase 2 — agent harness and trust boundaries; repeat in every model/tool upgrade gate.

---

### Pitfall 3: One sandbox for the agent, build, preview, and service credentials

**What goes wrong:** Generated code or an npm lifecycle script reads service secrets, accesses other workspaces, reaches metadata/internal services, mines resources, or escapes a worker. A browser preview can also turn an overlooked egress route into data exfiltration.

**Why it happens:** Containerization is mistaken for complete isolation; the same runtime is reused for convenience; egress is left open for package installation; writable mounts and host sockets leak across phases.

**How to avoid:** Separate control plane from disposable execution. Each session gets an ephemeral, non-root, resource-limited sandbox with no host socket, no service account, no shared home/cache, read-only pinned toolchain, per-workspace filesystem policy, and default-deny network. Split dependency acquisition from the execution sandbox: resolve a reviewed immutable dependency bundle before the build, then build/test with no network. Preview the already verified static artifact in a separate browser sandbox. Use short-lived, scope-specific deployment credentials only in a publication adapter, never in agent context.

**Warning signs:** Sandbox needs a broad cloud token, Docker socket, workspace parent mount, or unrestricted DNS; `npm install` runs during generation; outbound logs show arbitrary hosts; escaped processes survive session teardown.

**Verification approach:** Run breakout and exfiltration canaries (metadata IPs, internal DNS, symlink traversal, `/proc`, lifecycle hooks, fork bombs) in CI and staging. Assert no outbound packets except explicitly tested allowlist destinations, zero readable credentials, and full teardown after both normal and crash paths.

**Phase to address:** Phase 2 — isolated worker platform; Phase 8 — independent security red-team gate.

---

### Pitfall 4: Letting generated dependency manifests and build scripts choose the supply chain

**What goes wrong:** A generated `package.json`, lockfile, plugin, postinstall script, or mutable version changes the trusted build. The artifact later cannot be reproduced, or a compromised package runs with worker access.

**Why it happens:** “It builds” is accepted as validation; semver ranges and package scripts are normal JavaScript defaults; scanning source but not the resolved tree overlooks the executable package manager path.

**How to avoid:** Start from the authoritative napplet scaffold and pinned lockfile. Permit only a small reviewed dependency allowlist; reject new registries, git/file dependencies, native modules, lifecycle scripts, and install-time downloads unless explicitly reviewed. Use immutable versions plus integrity hashes, an SBOM/provenance record, vulnerability/license policy, and hermetic/offline install. Rebuild from the lockfile before attestation and alert on any lock/toolchain drift.

**Warning signs:** Lockfile changes in a generation session; `preinstall`/`postinstall` keys; `latest`/range versions; git URLs; an unexplained new transitive dependency; build differs after cache purge.

**Verification approach:** CI attempts malicious lifecycle, tarball, registry, and dependency-confusion fixtures. Require an offline clean-room rebuild that emits the exact same aggregate hash and compare SBOM, lock digest, toolchain digest, and artifact digest to attestation inputs.

**Phase to address:** Phase 1 — reproducible scaffold/build; Phase 8 — supply-chain policy and monitoring.

---

### Pitfall 5: Crediting CEP-8/Lightning/Cashu top-ups more than once, or treating payment success as a balance mutation

**What goes wrong:** A repeated Nostr request, Lightning status callback/retry, or Cashu bearer proof credits an account twice. Conversely, the external settlement succeeds but a crash loses the credit. Balances are mutable totals, so corrections are unauditable.

**Why it happens:** Payment rails have different finality and retry behavior, while network handlers commonly use at-least-once delivery. Cashu proofs are bearer value: a proof must be redeemed and marked spent by the mint, not merely trusted because it parses. External settlement and local database writes cannot be one distributed transaction.

**How to avoid:** Build an append-only double-entry ledger first. Derive a canonical idempotency key per top-up (payment method + provider/mint identity + immutable payment/proof commitment + account); persist `received → verifying → settled/failed` atomically with the ledger entry. Verify Lightning settlement with the authoritative wallet/provider before credit; redeem/verify Cashu through a trusted mint and record the exact proof/keyset commitment before credit. Enforce uniqueness at the database level, never from application memory. Reconcile uncertain `verifying` records rather than automatically retrying credit.

**Warning signs:** Credit count differs from unique settlement identifiers; negative/duplicate ledger references; top-up retries change balance; a Cashu proof reaches credit code before mint redemption; admin fixes modify a balance column.

**Verification approach:** Fault-inject a crash before/after every persistence and provider call, duplicate every ContextVM/Nostr message, replay the same Cashu proof, and deliver Lightning confirmation out of order. Prove ledger conservation and exactly-once *credit* for each canonical settlement id; reconciliation must converge without human balance edits.

**Phase to address:** Phase 3 — identity, CEP-8 adapters, and financial ledger before any paid generation.

---

### Pitfall 6: Checking balance and cap before a model call but debiting only after it

**What goes wrong:** Concurrent revisions race through the available balance/cap, or a model call completes after the live balance changed. The service spends more than the user-approved maximum, undercharges expensive usage, or double-debits a retried provider response.

**Why it happens:** Provider usage is known only after completion, so teams implement a pre-check followed by a post-hoc debit. Floating-point money, unversioned pricing, and shared account rows make the accounting ambiguous.

**How to avoid:** Use integer minor units for money and provider-native integer usage units. Create a per-session authorization hold/reservation inside the same account-serialized transaction that admits one billable action; hold the pessimistic maximum allowed by remaining cap and funds, reject if none, then settle actual provider-verified usage against that hold exactly once. Persist provider request id, model/pricing version, usage receipt, action sequence, and ledger references before exposing the result. One session action id must map to one provider request and one settlement attempt; use an account coordinator/serializable transaction to prevent competing sessions from overspending.

**Warning signs:** `SUM(usage)` cannot be joined to ledger debits; cap enforcement occurs only in application code; decimal monetary values; retry creates a new provider request id; simultaneous revisions both pass an identical pre-check.

**Verification approach:** Property-test concurrent actions, retries after timeout, duplicate usage callbacks, provider price changes, partial output, and provider success followed by local failure. For every terminal session state assert: debits ≤ actual accepted usage, debits ≤ user cap, debits ≤ settled balance plus permitted hold, and no hold is orphaned past a bounded recovery interval.

**Phase to address:** Phase 4 — metering, reservations, cap enforcement, and revision semantics.

---

### Pitfall 7: Making the ten-minute top-up pause and 30-day resume a timer rather than a durable state machine

**What goes wrong:** A late top-up silently restarts costly work; a worker is kept indefinitely; a live pause loses an in-flight action; an expired checkpoint can still be resumed; two resume requests create two workers; restoring stale files invalidates the billed/verified state.

**Why it happens:** Live timers live in process memory, while checkpoint data is spread across logs, volumes, and accounting. “Paused” has no explicit ownership/sequence semantics.

**How to avoid:** Model states explicitly: `running`, `awaiting_top_up_live(until)`, `checkpointed`, `resuming`, `expired`, and terminal states. Commit a versioned checkpoint at every safe boundary containing conversation, agent state, workspace snapshot digest, validation evidence, usage ledger refs, pending action intent (not an already-issued provider request), policy/scaffold/toolchain versions, and expiry. The ten-minute deadline schedules release but has no authority to spend; only an explicit, signed user resume command can create the next action after a fresh cap/fund reservation. Use compare-and-swap session version/lease so only one worker owns a session. Encrypt checkpoint blobs, bind access to the Nostr pubkey, and delete/cryptographically render inaccessible at expiry under a tested retention job.

**Warning signs:** Paused sessions only exist in worker memory; resume has no idempotency key or session version; checkpoint includes raw secrets or mutable `/tmp`; top-up event itself calls the worker; durable data has no expiry report.

**Verification approach:** Kill workers at each pause/checkpoint/resume transition; send concurrent resume and top-up messages around 9:59/10:01; restore after regional failover; and attempt access after 30 days with clock-controlled tests. Verify exactly one next action, no unauthorised spend, byte/hash-consistent workspace, and durable evidence that expired data was removed.

**Phase to address:** Phase 5 — session continuity and durable checkpoint recovery.

---

### Pitfall 8: Previewing one build but publishing a rebuild or a different manifest

**What goes wrong:** A user approves a preview, but publication deploys mutated files, regenerated timestamps/manifest, a different aggregate hash, or a manifest whose d-tag/capabilities do not match the preview. The CVM attestation then proves only a build process, not what the user published.

**Why it happens:** Build, validation, deployment, and signing are distinct asynchronous steps; teams rerun build commands during publish and use path names instead of immutable artifact identities.

**How to avoid:** Make the verified artifact immutable and content addressed. Generate the NIP-5D kind 35129 manifest and its per-file/aggregate hash from that artifact; validation report and CVM attestation must include artifact digest, aggregate hash, scaffold/toolchain/lock digests, policy version, and session/action id. Publish only by reference to that sealed artifact. Have the trusted user signer display the exact d-tag, aggregate hash, capability requirements, and publication intent, then sign the owning manifest without exposing a private key. Revalidate final deploy bytes against the manifest before marking success.

**Warning signs:** Publish invokes `npm build`; a manifest is regenerated after preview; preview URL is not keyed by aggregate hash; attestation lacks lock/toolchain identity; signing UI hides manifest fields.

**Verification approach:** Deliberately mutate a file after preview, change manifest tags, swap the deploy bundle, and vary build timestamp/environment. Each case must block publication. An integration test fetches deployed bytes, recomputes every path hash and aggregate hash, verifies manifest/event/signature and attestation linkage, and compares them to the preview record.

**Phase to address:** Phase 6 — verified preview, user-owned manifest signing, and publication pipeline.

---

### Pitfall 9: Assuming Nostr relay publication is exactly once or globally ordered

**What goes wrong:** Timeout/retry produces duplicate publications or inconsistent relay presence. A crash after relay acceptance but before local acknowledgement causes an unnecessary new event; an attacker replays a transport message; replaceable/addressable event ordering surprises the UI.

**Why it happens:** Nostr is distributed and relay acknowledgements are not a database commit. NIP-01 event ids are deterministic only when the serialized signed event fields remain identical; rebuilding with a new timestamp changes the id.

**How to avoid:** Persist publication intent and the fully signed event bytes/id before relay I/O. Retry the identical event id to a configured relay set and treat NIP-01 `duplicate` acknowledgement as success for that relay. Record relay-level delivery attempts separately from a single logical publication; reconcile missing acknowledgements by querying event id, never by re-signing. Verify ContextVM message signatures, sender pubkey-to-account binding, timestamp/nonce/replay windows, capability name, and request id before state changes.

**Warning signs:** A retry creates a new event id; publication status is a boolean with no event id or relay detail; handler accepts any signed historical request; completion means “sent over socket,” not observed acknowledgement/reconciliation.

**Verification approach:** Simulate relay accept-then-disconnect, `duplicate`, delayed `OK`, partitions, replayed ContextVM messages, and two simultaneous publish requests. Assert one logical publication/event id, idempotent relay fan-out, and a recoverable `uncertain` state rather than a second signed manifest.

**Phase to address:** Phase 6 — publication idempotency; Phase 7 — transport replay and relay-failure resilience.

---

### Pitfall 10: Promising “start within five seconds, no queue” without an explicit overload contract

**What goes wrong:** Load creates an invisible queue in an API gateway, worker platform, database pool, or model provider. Accepted requests wait well beyond five seconds, or autoscaling stampedes and exhausts spend/worker quotas. p95 is reported from worker start rather than signed request receipt.

**Why it happens:** Product language treats rejection as failure, so every request is accepted. Cold-start tests use warmed single-region instances and omit sandbox provisioning, Nostr relay delay, account coordination, and provider admission.

**How to avoid:** Define admission before acceptance: authenticate, cheaply validate, reserve capacity/account action, and return a deterministic `busy/retry-after` response if a worker cannot be isolated and started within the SLO budget. No durable job backlog, no “accepted but pending” state. Keep a measured warm capacity pool sized from traffic and isolation setup time; bound per-user concurrent sessions and global work. Separate the five-second start SLO from eventual model completion and include end-to-end timestamps in every request trace.

**Warning signs:** 202/accepted response before worker lease; hidden platform queues; p95 excludes rejected requests or starts after allocation; capacity threshold is unknown; load test only measures one warmed region.

**Verification approach:** Run step-load and cold-start tests across target regions, forced scale-to-zero, dependency saturation, and relay delay. Report request-received → isolated-worker-ready distributions, rejection rate/reason, and queue depth (which must remain zero). Gate deployment on p95 ≤ 5 seconds at the declared capacity and a safe bounded rejection mode beyond it.

**Phase to address:** Phase 7 — admission control, capacity model, SLO instrumentation, and failure drills.

---

### Pitfall 11: Using eventual-consistency data or regional failover for money/session ownership

**What goes wrong:** Different regions see different balances, holds, leases, or publication states. During a partition, both regions start a worker, debit the same funds, or publish twice; later replication chooses a winner and loses accounting evidence.

**Why it happens:** Edge deployments make all storage look global. A KV cache is used as the ledger, or active-active stateless workers coordinate through best-effort locks. “Multi-region” is claimed without a documented write authority and recovery point/objective.

**How to avoid:** Establish one strongly consistent coordination authority for each account and session (for example, a per-account/session transactional coordinator); it serializes ledger mutations, cap holds, leases, and logical publication state. Other regions may authenticate/route/read cached non-financial data but must synchronously reach that authority or fail closed for billable transitions. Use fencing tokens/session versions on worker side effects, immutable object storage with replicated verified artifacts, transactional outbox records for relay/deploy calls, and regularly tested backups/reconciliation. Make regional-degradation responses explicit: no new paid action if correctness cannot be guaranteed; existing checkpoint remains recoverable.

**Warning signs:** Balance comes from cache/KV; two workers can hold the same session id; disaster plan says “retry everything”; no measured RPO/RTO; replica lag is not monitored; a region can independently sign/publish.

**Verification approach:** Game-day kill the coordinator region, cut inter-region connectivity, replay outbox deliveries, and fail over while actions/publish are in flight. Validate no double ledger entry, no cap breach, at most one active lease/fenced worker, no lost committed checkpoint, and documented SLO/degradation behavior.

**Phase to address:** Phase 7 — high availability and disaster recovery architecture, after phases 3–6 establish correct state machines.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Mutable `balance` column instead of append-only ledger | Fast prototype | Cannot prove/reconcile credits, holds, or actual-usage charges | Never for paid generation |
| Post-hoc debit after model call | Fewer state transitions | Cap overspend and uncapped provider liability | Never |
| One reusable worker with network access | Faster startup | Cross-user leakage, breakout blast radius, secret exfiltration | Never |
| “Prompt says do not…” guardrail | Simple agent setup | Jailbreak becomes privileged action | Only as non-authoritative UX guidance |
| Rebuild at publish time | Simple CLI integration | Preview/manifest/hash mismatch | Never |
| Queue accepted work in a database | Better apparent availability | Violates immediate-start promise and creates surprise spend | Never |
| Globally shared coordinator | Easy locking | Hot partition destroys p95/admission | Only for low-rate administrative reconciliation |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| NIP-5D/NAP shell | Grant browser APIs or accept messages by origin | Sandbox with `allow-scripts` only; bind `MessageEvent.source` to registered manifest identity and broker typed NAPs only |
| `@napplet/cli` and Vite plugin | Trust local dev manifest or regenerate deploy output | Pin versions; seal one `dist` artifact; recompute hashes from deployed bytes and publish its corresponding manifest |
| ContextVM/CEP-8 | Debit model usage through the protocol’s fixed-price path or assume retries are unique | Use CEP-8 only for separately idempotent top-ups; implement account ledger/cap reservation in transport-neutral core; pin SDK/spec behavior |
| Lightning | Credit on invoice creation or ambiguous callback | Credit only authoritative settled status using a unique payment identifier and reconciliation |
| Cashu | Store/replay bearer token text as proof of payment | Redeem/verify once with trusted mint; atomically persist proof commitment/spent result and ledger entry |
| Nostr relays | Re-sign event on timeout | Persist/retry same signed id; treat `duplicate` appropriately; record per-relay delivery and reconcile |
| Model API | Treat timeout as no usage | Persist request id before call; reconcile provider usage before retry/settlement |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Provisioning sandbox, dependencies, and browser only after acceptance | Cold-start p95 exceeds five seconds | Prebuild immutable worker image/dependency bundle, prewarm bounded capacity, admit before acceptance | First cold burst or provider image pull |
| Global ledger/session lock | Start latency rises for unrelated users | Shard serialized coordination by account/session; keep global aggregates async and non-authoritative | Moderate concurrent funded users |
| Holding a session lease across model/network I/O | Top-ups/resume blocked; retries pile up | Persist reservation/state then release/renew narrow lease; use fencing tokens | Slow model or relay call |
| Storing full checkpoint synchronously on every token | High latency/cost | Checkpoint at safe action boundaries with immutable workspace snapshots; stream logs separately | Long iterative sessions |
| “No queue” enforced only in application | Latency cliff with hidden queues | Observe platform/provider queue delay and reject once capacity budget is exhausted | Any autoscaling/provider saturation |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Giving agent a deployment key or user signer | **Critical:** irreversible unauthorised publication/key loss | User signs through trusted runtime; publication adapter gets no user key; agent never calls it |
| Passing secrets, other session context, or raw logs into model | **Critical:** injection-enabled data exfiltration | Per-session isolation, secret redaction, least-privilege typed tools, provenance-aware context |
| Allowing generated `npm` scripts/network at build | **Critical:** worker takeover and supply-chain compromise | Offline hermetic build, allowlisted lockfile, disabled lifecycle scripts, no-secret sandbox |
| Using browser origin as napplet identity | **High:** opaque iframe identity confusion/spoofing | Map and verify `MessageEvent.source`; reject unmapped windows |
| Treating prompt/output scanning as conformance | **High:** banned authority reaches artifact | Static AST/bundle/manifest checks plus real browser capability tests |
| Resuming solely because account got funded | **High:** surprise spending | Explicit user-signed resume plus new action/cap reservation |
| Trusting a relay transport message without replay control | **High:** repeated paid action/top-up/publish | Verify signature/account binding; canonical request id, nonce/timestamp window, durable idempotency records |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Displaying a balance but not holds, actual usage, cap remaining, or prices version | User cannot predict spend or dispute a charge | Show append-only action ledger, reserved vs settled amount, usage receipt, cap/funds remaining, and paused reason |
| Calling a pause “failed” or silently restarting it on top-up | Work appears lost or funds are spent unexpectedly | Explain live ten-minute window, durable 30-day checkpoint, expiry, and require an explicit resume action |
| Asking user to sign opaque publication data | User signs unexpected ownership/capabilities | Display d-tag, aggregate hash, required NAPs, deployment target, and attestation summary before signing |
| Reporting “published” after one socket send | User sees a broken/invisible napplet | Report immutable event id, artifact hash, relay/deployment confirmations, and any reconciling state |
| Accepting requests when capacity cannot honour the SLO | Long silent wait and duplicate retries | Reject immediately with a clear retry-after/capacity condition; never create a hidden queued job |

## "Looks Done But Isn't" Checklist

- [ ] **NIP-5D conformance:** A build passes static checks, but the iframe is not tested with `allow-scripts` only and spoofed `postMessage` sources — verify real Chromium runtime behavior.
- [ ] **Top-up:** Payment UI works, but duplicate message/callback/proof tests and ledger conservation are missing — verify exactly-once credit under crash/retry.
- [ ] **Metering:** A total charge is shown, but provider request IDs, price version, actual usage receipt, reservation, and cap invariant are absent — verify reconciled per-action accounting.
- [ ] **Pause/resume:** Session restarts locally, but concurrent explicit resume, expiry deletion, regional recovery, and action idempotency are untested — verify the full state machine.
- [ ] **Preview/publication:** Preview works, but deploy bytes are not recomputed against the signed manifest and attestation — verify hash continuity end-to-end.
- [ ] **No-queue SLO:** A benchmark reports warm handler latency, but request receipt → isolated worker-ready p95 and overload rejection are not measured — verify at declared load and regions.
- [ ] **HA:** Data replicates, but a partition/failover test has not established a single financial/session writer — verify fail-closed paid transitions and reconciliation.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Suspected sandbox/secret breach | HIGH | Quarantine affected workers/artifacts, revoke scoped credentials, preserve forensic hashes/traces, notify impacted users, rebuild from clean immutable images, and revalidate pending artifacts |
| Duplicate/missing top-up or debit | HIGH | Freeze affected account’s paid admission, reconcile immutable ledger against provider/mint evidence, issue compensating ledger entries (never edits), then remove the faulty idempotency path |
| Cap overspend/uncertain provider usage | HIGH | Stop session, retain checkpoint, reconcile request id/usage receipt, settle or compensate visibly, and require new user authorization before further action |
| Checkpoint corruption/dual resume | MEDIUM | Fence stale lease, select latest hash-verified checkpoint, rebuild workspace from immutable snapshot, append recovery event, and make user explicitly resume if action intent is uncertain |
| Manifest/hash/publication mismatch | MEDIUM | Mark publication invalid/uncertain, do not silently republish, retain signed evidence, rebuild/validate anew, and have user sign the corrected manifest |
| Relay/deploy partial failure | LOW–MEDIUM | Keep logical publication pending with same event id/artifact; query/retry individual destinations, then reconcile status without a new signed event |
| SLO/capacity incident | MEDIUM | Enter immediate-reject mode, drain no durable queue, protect active isolated workers, scale only within tested limit, and publish measured recovery evidence |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Sandbox authority/capability violation | Phase 1: napplet contract and conformance | Forbidden-authority static scans plus real Chromium/NAP spoofing tests |
| Supply-chain drift and build scripts | Phase 1, reinforced Phase 8 | Offline reproducible build, SBOM/lock/toolchain/artifact digest match |
| Prompt injection and excessive agent authority | Phase 2: agent harness security | Adversarial tool-trace corpus proves no privileged side effects |
| Worker breakout, egress, and secret exposure | Phase 2, reinforced Phase 8 | Breakout/exfiltration canaries and teardown tests |
| Top-up double-credit/lost-credit | Phase 3: payment adapters and ledger | Crash/replay/property tests prove exactly-once ledger credit |
| Usage mismatch, duplicated debit, cap overspend | Phase 4: metering/caps | Concurrent action and provider-timeout reconciliation invariants |
| Ten-minute live pause and 30-day resume | Phase 5: session continuity | Kill/restart/concurrent-resume/expiry/failover state-machine tests |
| Preview/manifest/build-hash mismatch | Phase 6: sealed artifact and signing | Fetch deploy bytes and recompute manifest/attestation linkage |
| Duplicate Nostr publication/replayed transport | Phase 6 then Phase 7 | Retry/partition tests preserve one signed event and one logical publication |
| Five-second p95/no queue overload promise | Phase 7: admission and SLOs | Regional cold/step-load test records receipt-to-isolated-ready p95 and zero durable backlog |
| Multi-region split brain and disaster recovery | Phase 7: HA correctness | Partition/failover game day shows no double charge/publish/lost committed checkpoint |

## Sources

- [NIP-5D explained — napplet](https://napplet.run/docs/guide/nip-5d.html) — MEDIUM: project documentation explicitly says the normative source is the experimental NIP PR/NAP track; used for implemented package behavior.
- [NIP-5D proposal (PR #2303)](https://github.com/nostr-protocol/nips/pull/2303) — MEDIUM: living experimental specification; pin the accepted revision during implementation.
- [napplet Vite plugin manifest/hash workflow](https://napplet.run/docs/packages/vite-plugin.html) — MEDIUM.
- [NIP-01 basic relay protocol](https://github.com/nostr-protocol/nips/blob/master/01.md) — MEDIUM: primary specification retrieved through the Brave research provider; use its pinned revision for implementation.
- [ContextVM documentation](https://docs.contextvm.org/) and [CEP-8 specification](https://docs.contextvm.org/spec/ceps/cep-8/) — MEDIUM: current experimental protocol/SDK documentation, must be contract-tested at pinned versions.
- [Cashu protocol](https://docs.cashu.space/protocol) — MEDIUM: source found through the Brave research provider; provider/mint integration specifics still need adapter-level verification.
- [OWASP LLM Prompt Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) and [OWASP LLM Top 10](https://owasp.org/www-project-top-10-for-large-language-model-applications/) — MEDIUM: source found through the Brave research provider.
- [Cloudflare Durable Objects rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) and [storage options](https://developers.cloudflare.com/workers/platform/storage-options/) — MEDIUM: useful implementation reference only; final infrastructure selection is undecided.
- [GitHub guidance on script injection](https://docs.github.com/en/actions/reference/security/secure-use) — MEDIUM: source found through the Brave research provider.

---
*Pitfalls research for: napplet-cvm*
*Researched: 2026-08-03*
