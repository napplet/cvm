# Payments and credits

The CVM owns Nostr-linked accounts, the integer credit ledger, signed spending
limits, metered usage, admission, and pause/resume. An operator installs payment
adapters separately. The public application contains no Lightning wallet, Cashu
swap, payment verification, subscription, or exchange-rate implementation.

The application can run with no payment adapter. A free deployment uses an explicit
allowlist of npubs or canonical public keys and an operator-defined credit limit
per request. Sponsored usage still passes through the ledger and the user's
signed maximum. An unlisted identity cannot generate, obtain sponsored credits,
or access owner-scoped tools.

## Units and pricing

Credits are positive canonical integer strings, bounded by `Number.MAX_SAFE_INTEGER`.
Use integer or rational arithmetic. Existing databases and v1 wire contracts retain
the historical `sat` unit and field names, including `reserveSat`. These names are
compatibility identifiers; an arbitrary adapter must not interpret them as its
payment currency. Existing balances are never redenominated or reset.

There are two independent policies:

1. **Usage price:** an immutable model price card defines credits charged per usage
   dimension. Every authorized operation pins its card. The service accepts a
   normalized pricing document. `bun scripts/model-pricing.ts --credits-per-usd
   1000/1 --policy-id credits-v1` captures provider prices and the operator's exact
   credit ratio. It does not fetch a currency exchange quote. Usage rounds up using
   the existing exact billing rules.
2. **Credit sale or grant:** the payment adapter verifies a payment or subscription
   event and determines the integer credits to issue. Its conversion, fees,
   promotions, exchange quotes, and subscription periods belong to the adapter.
   `purchasedCredits(amount, ratio)` is an optional exact conversion helper which
   rounds down and rejects zero or overflow. Persist the quoted price and policy
   before starting payment. A retry must use the original quote.

Changing a sale price affects future purchases only. It does not revalue balances,
change a held maximum, or change a pinned usage card. Adapters can accept several
currencies while issuing the same deployment's credit denomination.

## Adapter contract

The public contracts live in `src/payments/contracts.ts` and
`src/payments/loader.ts`. A module exports `version = 1` and
`create(host, options)`. It returns a `PaymentAdapter` with a unique `id`, one or
more method descriptors, and `request(input)`. Optional `statuses`, `reconcile`,
and `close` implement lifecycle projection, settlement recovery, and cleanup.

The host supplies a credit grant port scoped to the configured adapter ID, the
application database pool for durable adapter records, a derived encryption key,
and the accounting realm. Adapter modules are trusted operator code. Their code,
configuration, credentials and database access must never reach generated workers
or applet frames. The module path comes only from deployment configuration, never
from a user request. Keep secret values in mounted private files; pass their paths
through adapter options.

`request` receives the transport-verified principal. Modern `top_up` calls provide a `credits` target. The adapter quotes and verifies its source-currency amount, including explicitly approved fees. The optional legacy `amount` field retains its original source-amount semantics; it is not an exchange-rate instruction to the CVM. It may initiate checkout or
verify direct payment data. It returns only finite payment instructions and state.
The CVM strips unknown result fields before sending the signed, encrypted reply.
Pending checkout, an invoice, or a browser callback must never create credits.

After its own authoritative verification, an adapter calls:

```ts
await host.credits.grant({
  principal: { pubkey: verifiedReceipt.ownerPubkey },
  reference: verifiedReceipt.stableEventId,
  credits: verifiedReceipt.quotedCredits,
  policyVersion: verifiedReceipt.creditPricePolicy,
  verifiedAt: verifiedReceipt.settledAt,
});
```

The reference is unique within that adapter across all owners. Include a
subscription period or renewal event ID when appropriate. The CVM hashes and
namespaces it, then commits the credit and replay result atomically. Repeating the
same grant credits once, including after restart or concurrent delivery. Reusing
the reference for another owner is rejected. Changing its amount or price policy
is an idempotency conflict. A later observation timestamp does not alter the first
committed audit time. The grant port is never a public tool or HTTP endpoint.

Granting credits does not authorize a new action or increase a session maximum.
Existing continuation and explicit-resume rules still apply. Settlement pollers
must recover original provider operations; they must not blindly repeat ambiguous
payments. Persist adapter state and quote identity in its own tables or external
service before performing payment I/O.

## Configuration

```json
{
  "funding": {
    "mode": "adapters",
    "reserveSat": "3750",
    "adapters": [
      {
        "id": "operator-payments",
        "module": "/opt/operator-payments/src/adapter.ts",
        "options": { "credentialsFile": "/run/secrets/payments" }
      }
    ]
  }
}
```

Install and pin the operator's package and dependencies in the deployment image or
read-only module mount. The example path is a deployment choice, not an included
package. The source distribution exposes `napplet-cvm/*` imports for adapter
contracts. An adapter project can use a local file dependency during development;
deployment packaging resolves that package name to the pinned application source.
The public service image does not install an operator adapter automatically.

For free access, replace the whole funding object:

```json
{
  "funding": {
    "mode": "free",
    "allowlist": ["<operator-approved npub or 64-character lowercase public key>"],
    "maximumCredits": "10000",
    "reserveSat": "3750"
  }
}
```

Free mode never loads payment modules or payment credentials. It does not require
a mint or wallet service. Model credentials and isolated execution remain
deployment concerns.

## Multiple methods and clients

Each adapter can advertise several methods. IDs are unique across the whole
deployment. Discovery and `service_info.paymentMethods` describe only installed
methods; no provider pair is mandatory. A client selects a method ID and calls
`top_up` with the normal signed ContextVM negotiation. Direct payment payloads
remain inside the encrypted request. The adapter validates its own payload and
fee rules.

The bundled workspace presents a method selector when several methods exist.
Adapters return an invoice/request string or an HTTPS checkout link; the client
observes the authoritative account projection until credits arrive. Free mode
omits the payment step. Other ContextVM clients may implement their own selector
using the same method descriptors.

## Migration and compatibility

The additive source-identifier migration preserves old payment records, balances,
keys, holds, projects and audit history. The extracted operator adapter retains its
original payment identities and encrypted custody records. Deploy it together
with the application revision. Back up first and retain the preceding application
and adapter revisions and database snapshot for recovery. A pre-extraction application refuses the newer migration history; returning to it requires an explicitly restored compatible snapshot. Never remove migration records or drop credit data to force a downgrade.

Historical provider entrypoints remain typed forwarding surfaces for existing
integrations. They contain no payment implementation and fail closed when none
is installed. `NAPPLET_CVM_PAYMENT_IMPLEMENTATION_ROOT` explicitly selects an
operator-owned implementation for those entrypoints. New adapters use the generic
module contract; they do not need the compatibility entrypoints. Provider-specific
tests and local wallet/mint stack definitions belong with their adapter.

## Guidance for implementers and agents

Read the contracts, registry, credit grant implementation, and
`tests/payments/contextvm.e2e.test.ts` before implementing an adapter. Keep the core
provider-neutral. Implement payment verification and quote persistence in the
operator package, then test it against its actual provider boundary.

Verify multiple methods, identical provider event IDs in different adapters,
concurrent delivery, restart replay, changed amount/policy conflicts, wrong-owner
events, ambiguous provider responses, fees and rounding, and redacted wire results.
Verify the generic core with `bun test tests/payments tests/service/config.test.ts`
and `bunx tsc --noEmit`. Run the adapter's provider and settlement-recovery tests
separately. A payment implementation is complete only when an actual configured
runtime proves credit, admission, generation and restart behavior without resetting
existing accounts or state.
