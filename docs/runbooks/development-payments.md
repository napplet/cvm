# Development payments

The CVM uses operator-installed payment adapters. The public repository includes
credit accounting, generic adapter contracts and payment-free access; it does not
include a wallet, mint, subscription or payment-provider implementation.

See [payment adapters](../architecture/payment-adapters.md) for configuration,
integer credit pricing, the grant port and integration tests. A service configured
with `funding.mode: free` needs an explicit npub allowlist and a bounded credit
maximum, with no payment services or payment credentials.

## Existing development launcher

The retained development launcher can use an installed compatibility adapter.
Set `NAPPLET_CVM_PAYMENT_IMPLEMENTATION_ROOT` to its source root and
`NAPPLET_CVM_APPLICATION_ROOT` to this application checkout. The adapter owns its
payment stack, provider dependencies and detailed operating instructions.

```sh
export NAPPLET_CVM_PAYMENT_IMPLEMENTATION_ROOT=/path/to/operator-payment-adapter
export NAPPLET_CVM_APPLICATION_ROOT=/path/to/napplet-cvm
bun scripts/dev.ts up
bun scripts/dev-payments.ts test
```

These commands forward to installed implementation code and fail closed when it
is absent. The isolated test command must own a separate stack, identity and
configuration; it must never reset an operator deployment. New adapters use the
generic module contract and the provider-neutral service composition instead of
implementing the compatibility launcher.
