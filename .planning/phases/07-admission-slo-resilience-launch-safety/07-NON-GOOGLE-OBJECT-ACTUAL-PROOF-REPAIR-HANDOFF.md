# PostgreSQL object actual-proof repair handoff

**Scope:** bounded follow-up to hosted run `41219080120`; this remains an
unselected, no-provider-effect PostgreSQL candidate.

## Observed failures and repair

- A completed tombstone was idempotent even after a higher physical generation
  replaced the same logical key. `019` now rejects that stale reference with
  `OBJECT_EXACT_GENERATION_REQUIRED`; idempotency remains only while the
  tombstoned generation is still the per-key head. The SQL transition never
  deletes or observes the replacement generation.
- The retention fixture accidentally awaited `open()` before giving its promise
  to `expect(...).rejects`, so the intentional denial escaped and prevented the
  remaining custody-boundary assertions. The assertion now awaits the matcher,
  allowing the ENOENT-only confirmation, durable `erasing`, `isDestroyed=false`,
  and restart-finalization cases to execute in hosted PostgreSQL.

## Evidence boundary

The local runner has no authorized PostgreSQL daemon, so local focused tests skip
their integration cases. A natural new-head PG17 workflow run is required proof;
no rerun, cancellation, production selection, provider, host, or credential
effect was performed. Unknown backup, WAL, replica, broker, Borg, HSM and
forensic-erasure copies remain held outside the declared filesystem-root fixture.
