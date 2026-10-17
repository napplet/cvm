# Generation workflow

The sequence is **fund → reserve → generate → inspect → revise or publish**. All account/session operations use the same verified caller identity. Funds do not start work by themselves.

## 1. Discover and inspect

Read `service_info` in the development composition for the provider label, availability, current required ceilings and optional caller-scoped estimates. Estimates do not authorize spending or replace admission. Read `account_status` for available/held funds and existing work. `tools/list` shows names but is not proof every optional facade is installed.

## 2. Top up separately

`top_up` is the CEP-8 funding capability. It supports Lightning BOLT11 and Cashu v4 direct payment. Its arguments include an idempotency key, PMI, interaction mode and decimal-string amount. A Lightning result can require paying an invoice before credit is confirmed; an issued invoice is not settled balance.

Cashu bearer material belongs in the **encrypted signed event's payment tags**, not ordinary tool arguments:

```json
[
  ["pmi", "bitcoin-cashu-v4-direct"],
  ["payment_interaction", "transparent"],
  ["direct_payment", "bitcoin-cashu-v4-direct", "<private-cashu-token>"]
]
```

The adapter validates these tags against the arguments. Do not log them. The repository's [browser ContextVM client](https://github.com/napplet/cvm/blob/main/src/dev-ui/browser/contextvm-client.ts) provides the pinned SDK payment-tag handling and `fundCashu` flow. The [payments runbook](../runbooks/development-payments) describes the automatic local mint/NWC environment. The MCP example intentionally does not implement wallet funding.

Repeat/read the existing top-up until credit is confirmed; never infer credit from a relay acknowledgment. Use the same payment identity on retries so the durable ledger prevents double credit.

## 3. Reserve funds and capacity

Illustrative tool arguments:

```json
{
  "idempotencyKey": "my-admission-001",
  "requestedCap": "3750",
  "unit": "sat"
}
```

Call `funded_admission`. Replace the example cap with an informed maximum meeting the service's current requirements. Continue only on `status: "accepted"`; store its `reference`. `refused` and `reconciliation_pending` do not grant execution authority.

## 4. Start one action

```json
{
  "admissionReference": "<accepted-reference>",
  "idempotencyKey": "my-generation-001",
  "maximum": "3750",
  "idea": "A simple focus timer with a start and reset button."
}
```

Call `start_session`. Inputs are bounded; the public idea/revision limit is 4,000 characters. Treat the returned session, version, operation ID and next action as durable references. Confirmed completion includes `code: "ACTION_COMMITTED"`; worker or model failures have different statuses.

In development, `{ "mode": "pre_admission", ... }` can save an unfunded idea. That returns a checkpoint/fingerprint for later approval, not a running generation job. After funding/admission, explicitly resume the same saved intent with `approvePendingAction: true` and its exact reference/fingerprint. See the [schema catalog](./schemas) for both resume variants.

## 5. Observe and recover

Use live progress for activity and `session_status` for durable truth. Save the returned version and latest verified artifact. After connection loss, query the same session/operation before trying another action. A timeout might leave work active or usage unconfirmed.

The status response supplies `nextAction`, including wait, funding/cap approval, revision, resume or reconciliation. Do not synthesize a new generation ID just to make an unknown action disappear. [Progress and errors](./events-and-errors) explains recoverable subscription failures and real-provider fencing.

## 6. Revise

Call `revise_session` with the owner session ID, current `expectedVersion`, admission reference, approved maximum, a new idempotency key and bounded revision text. Reuse that exact command/key for delivery retries. A new user request uses a new key. A stale version or changed payload under an old key is a conflict, not permission to overwrite work.

## 7. Preview and publish

`preview` reads a verified artifact descriptor/capability review. It does not publish or grant arbitrary shell capabilities. The development runtime variant is `development-paja-0.19.0`; other implementations must advertise/support their actual variant.

Development publication uses `development_publication`: look up the saved attempt, prepare an event and destinations if needed, have the client sign it, save that signature, copy/verify the blobs client-side, record copy results, then submit the exact signed event. The CVM confirms relay publication. Reopening restores the saved signature and destination results; retries reuse verified blobs and the original event without generation. See [publication preparation](./tools#development-publication-preparation). The general `publication` tool requires a promoted publication facade and is not installed by the current development composition.

Use [the user publishing guide](../users/publish-and-share) for the UX, and [the detailed runbook](../runbooks/development-gui#static-hosting-and-publishing) for NIP-65, Blossom lists, mirroring and relay confirmation. Keep user publication separate from CVM-owned preview sharing.
