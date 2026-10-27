# Production migration and rollback runbook

**Status:** planned no-effect preparation. This runbook authorizes no provider,
wallet, routing, provisioning or production cutover action.

## Preconditions and command boundary

The private service is operated from the homelab repository through
`./homelab cvm`. Existing `inspect`, `verify`, `runtime`, `deployment`,
`restart`, and `smoke --restore-only` commands remain private-service commands.
Future production `plan`, `deploy`, `status`, `certify`, `backup`,
`restore-test`, `cutover`, and `rollback` commands are planned work; operators
must not replace them with untracked host commands.

Both repositories must be reviewed and merged to `origin/main` and
`origin/master` before their configuration can back live state. The controller
must generate the exact candidate-bound authorization request. Provisioning,
migration, traffic cutover and cleanup may start only after its matching,
unexpired receipt validates. A changed candidate, topology, price source, cost,
scope, controller state or expiry requires a new request.

## A. No-effect inventory and restore rehearsal

1. Record the private deployment identity, source revision, service public key,
   origins, Coolify application ID, schema/migration versions, object/artifact
   digests, project/session counts, receipt counts and audit-row counts. Never
   record secrets, proofs, NWC URIs, preimages or tokens.
2. Classify data as retained `development-test` history, compatible
   non-monetary history, or new `production-real` authority. Preserve projects,
   sessions, artifacts, receipts and audits by digest. Keep ChatGPT credentials
   in development. Never import test balances, holds, credits or synthetic
   price history into the production-real ledger.
3. Restore an offline snapshot into a **fresh isolated instance** before any
   cutover is considered. Compare rows, object generations, content digests,
   artifact hashes, service identity and migration checksums with the source
   manifest. Read and decrypt a representative checkpoint only through the
   expected key broker, then validate its hash and owner/version fence. A
   restart of Beta is not a restore test.
4. If any count, digest, identity, generation or fence differs, stop and retain
   the snapshot for diagnosis. Do not repair source data in place.

## B. Backup-first preparation

1. Capture a timestamped pre-change manifest. Quiesce writers through Coolify
   where possible, checkpoint active work, take a consistent nested PostgreSQL
   dump or equivalent snapshot, and copy Beta host state and the engine volume
   with checksums. Never run `dev.ts reset`.
2. Restore that backup into the fresh instance and compare the same manifest.
   Retain the original backup immutably.
3. After receipt validation, create the production Cloud SQL PostgreSQL 17
   regional-HA authority and versioned dual-region GCS through run-owned
   operations. Create a zero-funded production-real schema/role. Apply only
   compatible schema transitions needed for retained data; historical files
   under `migrations/development` describe schema, not monetary authority.
4. Migrate compatible non-monetary history with idempotent original operation
   IDs and source digest checks. The preserved development-test ledger is
   read-only. Ambiguous rows stay unknown; never replace them with a recreated
   payment, worker, signing, upload or publication effect.

## C. Certification before cutover

1. Deploy only the receipt-bound candidate and pinned configuration; keep Beta
   private and serving its existing realm while certification runs.
2. Run all eight fresh suites. Admission evidence requires 1,000 accepted
   samples, two forced 200-attempt cohorts, p95 no higher than 5,000 ms,
   one-sided 95% confidence and zero accepted backlog.
3. Exercise encrypted checkpoint retention, ten-minute live-worker grace,
   explicit resume, lease recovery, Cloud SQL/GCS fresh-instance restore,
   original-operation payment reconciliation, user-owned signing and promoted
   CLI publication. Reconcile actual provider cost to the approved ceiling.
4. Let the sole evaluator verify the immutable release bundle. Missing, stale,
   synthetic, duplicate or failed records block promotion. Unresolved required
   cleanup is promotion-blocking.

## D. Authorized cutover

1. Revalidate candidate, topology, source prices, cost envelope, receipt and
   controller state. On any mismatch stop and regenerate the request.
2. Quiesce or checkpoint remaining private work, create a final pre-cutover
   backup, and re-run row/object/digest/identity comparison against production.
3. Enable production routes only after evaluator acceptance. Administration
   remains private and authenticated; ContextVM over Nostr remains public
   generation transport.
4. Record deployed CVM/homelab revisions, topology and evidence digests,
   endpoints, actual authorized and observed cost, cleanup result and rollback
   point. Do not claim availability beyond the tested failure domain.

## Abort, rollback and recovery

Before production-real funds are accepted, aborting preserves Beta, withdraws
the unpromoted route, deletes only receipt-owned resources, and restores the
verified snapshot if needed.

After production-real effects exist, never restore a stale financial backup over
the authoritative ledger. Remove traffic, keep the affected ledger read-only if
needed, and reconcile uncertainty query-only by original operation identity.
Forward recovery, an audited compensation entry, or a visible unknown state is
allowed. Blind reissue, redispatch, re-signing, re-uploading, re-crediting or
replay is prohibited.

Until drills pass, RTO and RPO are **unclaimed**. Two Cloud Run regions do not
by themselves establish cross-region database continuity.
