# Explicit session-cap approval

Implementation compatibility decision: [issue49](https://github.com/napplet/cvm/issues/49), recorded with merged PR50.

This project-schema amendment completes the existing `approve_cap` instruction.
At base revision `f2bcd4e`, a paused session can require a higher maximum but no
tool can approve it. A top-up changes the balance; it cannot grant permission to
spend beyond the accepted maximum. ContextVM SDK0.13.10 and MCP SDK1.30.0 stay
pinned. This is an optional project tool, not a change to CEP-8 or a Nostr NIP.

Before this amendment, a paused response can contain
`{"requiredAdditionalFunding":"2","requiredCapApproval":"2","nextRequiredAction":"top_up_and_approve_cap"}`
but the client has no corresponding command. The minimal alternative, a new
funded admission, changes the admission identity already bound to the paused
action and cannot safely authorize its replay. Reusing the original admission
with an explicit signed increase preserves that identity and its audit history.

## Request and authority

Known business refusals return `status: denied` with a finite code for ownership,
stale approval, insufficient funds, a non-increasing maximum, or idempotency
conflict. Invalid arguments retain the transport's invalid-request response.

For an owned session with an approved total of eight sats and a ten-sat pending
action, the owner first funds any shortfall and signs this ordinary ContextVM
request. Values below are synthetic:

```json
{
  "method": "tools/call",
  "params": {
    "name": "approve_session_cap",
    "arguments": {
      "sessionId": "session:example",
      "admissionReference": "admission:example",
      "idempotencyKey": "approve:example",
      "expectedApprovedCap": "8",
      "maximum": "10",
      "unit": "sat"
    }
  }
}
```

The server takes the principal and consent event reference from the verified
signed envelope. Neither is accepted as a tool argument. The client retains its
private key. Success returns `status=approved`, the session/admission/approval
references, `previousApprovedCap=8`, `approvedCap=10`, `heldAmount=10`, and `unit=sat`.
The admission reference remains the cap identity used by existing resume commands;
the new approval reference identifies the immutable increase audit.

`maximum` is an absolute total maximum, not an action price or an extra charge.
The transaction reserves only `maximum - previousApprovedCap`, using unheld
settled funds. It never consumes another admission's hold. Spending reduces held
funds while the approved total stays fixed. A zero remaining hold is valid.
There is no new credit, rail transfer, model call or worker allocation.

The compare-and-set maximum rejects concurrent stale approvals. Semantic
idempotency is scoped to the owner and this command; a new signed delivery of the
same command returns its original result. Changed arguments cannot reuse that
key. The initial consent reference is preserved. Approval, hold/projection
updates, billing evidence and the outbox record commit or roll back together.
Cap approval grants no automatic post-grace resume authority; explicit pending
action consent, original compatibility, funds and lease checks still apply.

## Compatibility, migration and rollback

Install `migrations/phase-07/005_production_session_caps.sql` through the approved
bundle. It adds a cumulative `approved_cap` beside the original requested and
remaining held values. Backfill uses the original accepted funding command,
including partially funded admissions; missing or ambiguous history fails the
migration. It does not infer money or rewrite old results. Every increase records
previous/new approved, requested and held amounts plus owner and consent.

The initial-insert trigger supports old writers without a new argument. Existing
settlement writers still change only remaining held funds. The immutable audit
and approval trigger prevent an unaudited maximum change. Startup checks the
new columns, restricted grants and enabled triggers before accepting work.
Account status now distinguishes the funded total from remaining held funds.

Normal MCP clients discover the optional tool. Older strict tool-name/count
validators may reject it and must be upgraded before relying on it. No existing
tool arguments, signed pending action, checkpoint or receipt bytes change.
Discovery marks cap approval unavailable when its real facade is absent. Roll
out compatible controllers before advertising the new tool across replicas.
The generated catalog format stays v1; it is not wire-version negotiation.

Rollback retains the column, guards and approval history. Already approved
funded increases must not be erased. Old controllers can enforce their existing
remaining-hold budget checks but cannot accept this new tool. Restore an old
archive and its original command history before applying the additive migration,
then start the checked reader; do not invent initial approved values during
restore. Fresh restore and live migration remain separate release gates.

## Validation and remaining work

The local restricted-PostgreSQL regression covers partial-funding preservation,
insufficient funds, another held admission, replay, changed arguments, stale
concurrency, zero remaining funds, immutable history, guard preflight and a lost
acknowledgement inside the final outbox transaction. A real signed-WSS fixture
uses the official ContextVM transports with disposable client/server keys. It
checks owner approval, duplicate delivery, forged principal arguments and a
different signed identity against the actual SQL service. It also checks stale
and conflicting commands and discovery with and without the installed facade.
An actual local `pg_dump`/`psql` restore into a new database retains every approval
receipt and initial admission result, replays the old command, and permits a new
funded increase through the restricted runtime role.

These are local protocol fixtures. No real funding, provider use or protected
suite is implied. The actual live-credit/pending-action producer and full
post-grace execution/settlement remain required before production activation.
The schema proposal and implementation must be reviewed together under the
[schema-change process](../developers/schema-changes.md).
