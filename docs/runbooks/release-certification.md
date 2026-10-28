# Release certification

Use one command for a candidate:

```sh
bun run release:certify -- --candidate <candidate.json>
```

No workspace argument or environment variable is required: controller state is
stored under the ignored repository-local `.runtime/release-certification`
directory. `NAPPLET_CVM_RELEASE_WORKSPACE` is an optional platform override
only when it is an absolute path within that controller-owned directory; paths
outside it are rejected before controller processing.

The command records a content-addressed state digest. A dry run performs only
local discovery and cost/effect planning; it cannot provision, execute a
protected suite, write protected evidence, finalize trust, promote, or clean
up a provider resource.

Before a protected execution, the user performs only the official provider
login or consent requested by the provider and then approves or verifies the
one exact controller-issued authorization digest. The controller derives the
configuration, topology, provider scopes, trust inputs, bounded USD-micros
cost, cleanup/retention, and candidate-bound evidence. Do not author or select
a certifier profile, registry, trust root, secret file, observation, or evidence
directory: the controller creates digest-pinned candidate-bound material itself
and never persists credentials.

The authorization request is regenerated when any candidate, topology, effect,
state, estimate freshness, expiry, or expected-receipt digest changes. No live
effect may start before that exact approval receipt validates.

Protected execution is enabled only by the platform's protected,
digest-pinned certifier configuration. That configuration names one
digest-pinned deployment session factory, which supplies the exact official
approval receipt, one all-family provider registry, protected-suite ports, and
finalization inputs for the candidate-bound run. It is deployment-owned: users
do not provide provider clients, credentials, receipts, evidence, or a factory
module on the command line or through environment variables. The checked-in
local evidence-only configuration deliberately stops before this boundary with
`RELEASE_PRODUCTION_EXECUTION_CONFIG_REQUIRED` and makes no provider call.

The protected completion contract is exact: `admission`, `telemetry`, `chaos`,
`restore`, `security-host`, `supply-chain`, `contextvm-payment-model`, and
`publication` must each have one fresh real record. The admission contract is
locked at 1,000 accepted samples for each worker provider, including 200 forced
pool-hit and 200 forced pool-miss attempts per provider, a one-sided 95% upper
confidence bound for p95 no higher than 5,000 ms, and zero accepted backlog. Missing, manual, synthetic, stale, or
duplicate records block trust finalization and promotion.

The local publication mechanism check is `bun scripts/test-publication-context.ts`.
It prepares a disposable trusted TLS certificate, starts restricted PostgreSQL,
and exercises NIP-46, the pinned CLI HTTPS upload and relay helpers, separate
service attestation signing, lost acknowledgements, and original-operation
observation after expiry. It requires Docker and OpenSSL. It does not contact
production providers or create protected release evidence.

Owner manifests retain the exact CLI-generated kind-35129 template. The separate
service key signs a kind-1 provenance note containing the typed
`cvm_build_attestation` record and owner-event/owner-pubkey/aggregate links.
The attestation is sent only after observing the original owner manifest. An
interrupted prepare without a retained signature stays unresolved. Historical
recovery observes the original upload and both event IDs; it cannot request a
signature, upload again, or publish another event. Full runtime restart recovery
and all eight protected suites remain release gates, even when local checks pass.

After interruption, rerun the same command with the candidate. To check the
stored redacted state, use `--status`; use `--resume <state-digest>` only when
the returned digest matches. Output contains candidate/topology/state and
authorization digests, never secret values. Cleanup is limited to resources
recorded as created by the approved run; an unresolved required cleanup remains
promotion-blocking.

Successful receipt execution returns the immutable `bundleSha256` handle.
The platform must activate the finalizer's independently pinned verification
configuration before invoking the read-only verifier:

```sh
bun run release:certify -- --verify-bundle <bundleSha256>
```

This accepts a 64-character digest, not a caller-selected file or trust module.
It reads the finalizer's bundle, checks candidate/topology/receipt bindings,
requires original-operation promotion and cleanup receipts, and runs the sole
release evaluator against the actual records and pinned source archive. Status
alone is not verification. Modified or stale evidence and missing cleanup block
verification. Activation of the final verification authority remains part of
the platform's production composition; users must not create a trust bundle.

Promotion and cleanup persist an atomic, synced claim before dispatch. After a
lost response or process crash, reconciliation queries that original operation;
it does not repeat the effect. An unavailable observation remains blocked.
