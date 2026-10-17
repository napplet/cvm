# Configuration reference

Run launcher commands from the repository root. Keep private values out of the static site and version control.

| Setting | Purpose / default |
| --- | --- |
| `NAPPLET_CVM_DEV_INSTANCE` | Isolated development instance; omitted means `default` |
| `CVM_CONFIG` | Public JSON file used by `scripts/build-workspace.ts`; default `.local/workspace/cvm.json` |
| `NAPPLET_CVM_PUBLIC_RELAY_URL` | Reachable `ws://` or `wss://` route to the same relay; local relay by default |
| `NAPPLET_CVM_BLOSSOM_PUBLIC_URL` | Advertised HTTP(S) origin for the existing Blossom listener; local origin by default |
| `OPENAI_API_KEY` and four `NAPPLET_CVM_OPENAI_*` variables | Optional complete [API provider configuration](./providers#use-an-api-account) |

There is no public HTTP generation endpoint and no supported local-model URL setting. Launcher-injected variables for ports, private paths and process bookkeeping are internal implementation details.

## Public connection document

```json
{
  "relayUrl": "wss://relay.example.org",
  "servicePubkey": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

This is illustrative: replace the relay and 64-character hex public key with your CVM's real values. A public key cannot be used to sign as the service. Do not add API keys, NWC URIs, OAuth state, browser identities or admin credentials to this document.

## Files and state

| Location, relative to the active state root | Contents |
| --- | --- |
| `cvm-operator/operator.json` | Private operator signer, API accounts and selection/rates |
| `development-chatgpt/` | Private persisted OAuth/provider state |
| `development-published/` | Published content-addressed blobs and persisted listener origin |
| `development-published/origin.json` | Loopback Blossom port used behind a reverse proxy |

The default launcher record is `.local/napplet-cvm-dev-launcher.json`; a named instance uses `.local/napplet-cvm-dev/<name>/launcher.json`, with its application state under `state/` and payments under `payments/`. The default payment configuration is `.local/napplet-cvm-dev-payments/payments.json` and contains private connection material.

Use the launch record's `stateRoot` and `configPath` when automating; don't assume every instance uses the default paths. See [operations](./operations) before backups or moving state.
