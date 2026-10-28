# Original paid-model recovery

Tracked in [issue55](https://github.com/napplet/cvm/issues/55). This internal
recovery expansion changes no public tool schema, checkpoint format or SQL table.

A paid call can outlive its controller deployment and current price quote. At
mainline `6d2283b`, signed command replay selects current prices before finding the
original prepared action. The shared Vertex client also correctly rejects a
record from another candidate. Recovering that call needs its original context.

## Authority and execution

Command replay verifies the original owner and complete command fingerprint.
The existing action supplies the original session, expected version, admission,
budget, operation, profile and card. Recovery precedes fresh affordability and
settlement preparation. It never authorizes another budget or creates another
operation. Exact terminal replay remains read-only. Revision and internal repair
replay use the same path before new-action readiness checks.

The production retained-pricing reader joins the owner-scoped action to immutable
catalog rows, verifies every action binding and both normalized-content hashes,
and parses the original profile/card. Source freshness is not extended. A
not-yet-dispatched action whose profile/card changed is refused; recovery prices
cannot authorize new work.

The production original-receipt router proves the owner/action/operation/budget/
profile/card/fingerprint tuple in restricted SQL before journal or provider
access. It verifies the immutable profile hash and exact maximum units, retained
request digest, nonce, prompt and request bounds. The original project, model and
location must equal those currently approved. It reconstructs the original
candidate client solely to reconcile that operation; no dispatch method is
exposed. The shared client's candidate/project check remains unchanged.

Provider access uses the current credential locator for that same approved
project. A changed project cannot reuse this route. Known resource IDs use the
original resource GET; lost creation acknowledgements use the existing bounded
list/GET matcher. No paid POST is retried. Missing, unmatched or uncertain
original evidence stays unresolved.

Settlement reuses the existing operation-bound FX journal and original provider
receipt. Today's quote cannot replace the original conversion. Retained pricing
and provider contexts read from the restored database when the existing fresh
restore composition reconstructs operational dependencies.

## Compatibility, rollout and rollback

No migration or public catalog change is needed. Existing immutable prices,
requests, nonces, receipts and operation IDs remain untouched. Upgrade the
controller with the reader/router and preserve its stable service journals.
Rollback can read the same records, but an older controller may leave a
cross-candidate unresolved call pending. Preserve the journals and use a
compatible reader to finish recovery; never reissue to escape that limitation.

This path does not enable production USD pending-command resume or authorize a
fresh paid call using an expired quote. Such a command has no already-paid
original to reconcile. Original executable context, fresh-price consent where
required, revision workspace lineage, physical retention and live release
certification remain separate unfinished work.

## Verification

The composed test runs restricted PostgreSQL and the actual HTTP adapter,
Vertex journal/client, source store, gateway, generation core and settlement.
The first POST loses its acknowledgement. A new controller has a different
candidate, profile, card and FX quote; the original source expires. Its current
price exceeds the nine-test-sat approved cap. Recovery performs two GETs, one
build, one original action/budget and one six-test-sat charge. Terminal replay
performs no new provider request or build. Foreign owner/budget/profile, changed
prompt/bounds and another project are rejected before provider access. The
shared current client still rejects the old candidate.

A separate revision test recovers an uncertain revision using its held original
budget before new-action readiness and affordability. These tests use explicit
HTTP, credit and worker fixtures. They are not real provider billing, isolated
build or protected release-suite evidence.
