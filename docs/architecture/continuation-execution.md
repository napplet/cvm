# Exact pending-action execution

Schema proposal: [issue51](https://github.com/napplet/cvm/issues/51), pending
compatibility review alongside the implementation.

This is an internal, unselected continuation implementation. The production
runtime does not install its executor or command protector yet. It is not a
claim of working production resume, real API usage or release certification.
It builds on the [session-cap proposal](./session-cap-approval).

## Contract and compatibility proposal

At base `f2bcd4e`, a paused intent retains a payload hash but cannot reproduce
the exact bounded generation command. Resume claims a provider operation before
worker allocation and returns after restore, with no terminal action producer.
A new provider dispatch through the ordinary coordinator would therefore enter
lookup-only recovery before its first request.

The optional internal `protectedCommand` envelope retains the exact command in
the existing pause transaction. AES-GCM encrypts it under a random per-command
DEK, wrapped by the mounted checkpoint KEK. Its AAD binds the complete pending
intent, owner, session, versions, policy, admission, command identity and expiry.
No plaintext enters the pause response. Missing keys, changed bindings, invalid
commands and expiry deny decryption. No user private key is received.

Old rows without this field remain readable. The installed executor refuses
them before budgets or worker allocation because it cannot reconstruct the
original command. The legacy restore-only path remains available to existing
callers when no executor is installed. Old strict readers may reject new pause
JSON; deploy compatible readers before enabling the writer. Rollback must retain
the envelope and key access and use a compatible reader for these active pauses.
Never remove the envelope, rewrite the prompt or invent an equivalent command.

An installed consumer can return the additional finite resume result:

```json
{
  "status": "reconciliation_pending",
  "code": "RESUME_ACTION_RECONCILIATION",
  "sessionId": "session:example",
  "checkpointId": "checkpoint:example",
  "pendingActionReference": "pending:example"
}
```

This distinguishes an uncertain action from allocation, object and restore
uncertainty. Existing request bytes and success shapes stay unchanged. Strict
result-code clients need this union member before the executor is enabled;
the documentation catalog label is not a negotiated wire version. This belongs
to the project tool schema, not CEP-8 or a Nostr NIP. SDK pins remain unchanged.

## Accounting and recovery

Preflight decrypts the original command and checks exact profile/card/toolchain
and the original action ceiling before the resume authority creates a claim.
The current consumer supports the same-currency path. A configured USD/FX
settlement port is rejected before financial/provider effects: the original
conversion and executable provider context must be implemented first. There is
no fallback to a new price or conversion.

Resume reserves one durable budget, prepares one action, allocates the original
worker intent and commits the restore observation. Only then does the ordinary
metered execution path claim the provider operation. Every tuple is checked
against the prepared SQL action before dispatch: owner, session, version,
admission, fingerprint, action, operation, budget, profile, card and ceiling.
It does not create another reservation or operation.

The provider result passes through the ordinary receipt, source, worker,
artifact and settlement path. Finalization uses the prepared resume action key,
not the original generation command key. Terminal accounting and retirement of
the exact restored pause/lease commit in one existing transaction. Unknown usage
and billing failures remain in reconciliation and cannot retire that lease.

Exact claim replay is distinguished internally from creation without changing
the stored claim identity or result. It reuses the existing budget even when
settlement has reduced the current balance. Terminal replay reads the original
action and completed pause without another allocation. Unknown provider work
uses lookup on the original operation; a lost acknowledgement never authorizes
a second dispatch.

## Local evidence and remaining gates

Restricted PostgreSQL exercises a natural partial-funded pause (8 of 10 test
sats), top-up, explicit cap increase, uncertain allocation, one lost provider
acknowledgement, one receipt lookup, one build and one 3-test-sat charge. A new
controller recovers the same command and original IDs. The terminal SQL commit
acknowledgement is also lost after commit; recovery observes the existing charge
and retired lease. A later terminal replay
does not allocate. The test verifies one claim, budget, action and operation,
cleared lease, changed-context denial and no USD/FX repricing fallback.
Its rail, archive, model and worker are explicit protocol fixtures.

Production still needs an actual pending-only initial archive/release producer,
real prior-workspace lineage for revisions, retained original provider/FX
context, within-grace credit/cap wake execution, production constructor wiring,
command-key erasure and claimed-checkpoint retention cleanup. Expiry refusal
alone does not prove physical erasure or backup retention. No protected suite or
30-day elapsed retention proof is implied.
