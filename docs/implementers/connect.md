# Connect with TypeScript

## Run the working read-only example

Start the [local stack](../operators/quick-start), then run from the repository root:

```sh
LOG_LEVEL=silent bun examples/contextvm/read-status.ts
```

The script prints `service`, `account` and `projects`. It does not fund an account, generate an applet or publish anything. An empty project list is expected for its new identity.

It reads `.local/workspace/cvm.json` and creates a private, stable client key at `.local/docs-client.key`. Override either path with `CVM_CONFIG` or `CVM_CLIENT_KEY_FILE`. Keep the key file across runs to retain the same project/account identity. It is a **client** identity, separate from the service and operator keys. Do not copy it into your static website.

For a separately installed client, pin the tested dependencies:

```sh
bun add @contextvm/sdk@0.13.10 @contextvm/mcp-sdk@1.30.0 zod@4.4.3 nostr-tools@2.24.1
```

The [example directory](https://github.com/napplet/cvm/tree/main/examples/contextvm) contains the connection helper and executable scripts; the repository already supplies the dependencies through its frozen lockfile.

## The connection

```ts
import { Client } from '@contextvm/mcp-sdk/client';
import { NostrClientTransport } from '@contextvm/sdk/transport';
import { EncryptionMode } from '@contextvm/sdk/core';
import { PrivateKeySigner } from '@contextvm/sdk/signer';
import { z } from 'zod';

// Obtain these from your private client configuration and the public cvm.json.
const client = new Client({ name: 'my-client', version: '1.0.0' });
const transport = new NostrClientTransport({
  signer: new PrivateKeySigner(clientSecretHex),
  relayHandler: [relayUrl],
  serverPubkey: servicePubkey,
  encryptionMode: EncryptionMode.REQUIRED,
  logLevel: 'silent',
});
await client.connect(transport);
try {
  const status = await client.request(
    { method: 'tools/call', params: { name: 'account_status', arguments: {} } },
    z.object({}).passthrough(),
    { timeout: 15_000 },
  );
  console.log(status);
} finally {
  await client.close();
}
```

This is an excerpt; `read-status.ts` supplies and validates the configuration. For application code, validate each returned domain shape with its corresponding schema instead of accepting an arbitrary object.

The current CVM returns **domain results directly** in JSON-RPC `result`. Therefore the native example uses `client.request` with an explicit result schema. A stock `client.callTool` expects MCP content blocks. Use the [compatibility proxy](./mcp) when connecting an ordinary MCP host.

## Browser signers

Use the user's extension or remote signer through a compatible signer interface with NIP-44 support. The application already integrates applesauce signers, NIP-07 and NIP-46. Follow [the existing browser implementation](https://github.com/napplet/cvm/tree/main/src/dev-ui/browser) for persistence, signer adaptation and identity changes.

The CVM derives the owner from the verified signed request. Never add an arbitrary `owner`, `npub` or `principal` argument to a tool. Changing your signer changes which projects and funds you can access. Keep an in-flight action associated with the signer that authorized it.

## Request lifecycle

Let the SDK handle event signatures, encryption and request-event correlation. Correlate replies by JSON-RPC ID; use a different **application idempotency key** for a new intended action. A reconnect is not a new authorization to spend.

Read [workflow](./workflow), [tool reference](./tools) and [progress/errors](./events-and-errors) before implementing writes. Set a whole-action timeout that includes model, worker and settlement; a transport timeout alone does not prove the action failed.
