# Use the CVM from an MCP client

A local **`NostrMCPProxy`** connects an MCP host's stdio transport to the remote CVM over Nostr. The local process holds your client signer. The CVM remains in its own process or on another machine.

```text
MCP host → stdio → ContextVM proxy → encrypted Nostr relay → napplet-cvm
```

The SDK proxy is the client-side direction. A ContextVM gateway wraps an existing MCP server in the opposite direction. See the [SDK overview](https://docs.contextvm.org/reference/ts-sdk/quick-overview/) and [gateway documentation](https://docs.contextvm.org/reference/ts-sdk/gateway/overview/).

## Configure a host

Install the repository's frozen dependencies and start the CVM. Adapt this generic stdio configuration to your host's MCP settings, using absolute paths:

```json
{
  "mcpServers": {
    "napplet-cvm": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/cvm/examples/contextvm/mcp-stdio.ts"],
      "env": {
        "CVM_CONFIG": "/absolute/path/to/cvm/.local/workspace/cvm.json",
        "CVM_CLIENT_KEY_FILE": "/absolute/path/to/private/napplet-client.key",
        "LOG_LEVEL": "silent"
      }
    }
  }
}
```

Find Bun's path with `command -v bun`. For a remote CVM, create your own public `cvm.json` containing its relay and public key. The bridge creates the private client key file if missing and rejects permissive file permissions. Keep this file to retain the same identity. It does not sign you in as an existing browser identity automatically.

Refresh the host's MCP tools. You should see six tools: `service_info`, `account_status`, `projects`, `session_status`, `preview` and `operation_diagnostic`. `projects` exposes only `list` and `get`. Try asking the host to check the service and list your projects.

## Verify without an agent host

From the repository root, with the CVM running:

```sh
LOG_LEVEL=silent bun examples/contextvm/check-mcp.ts
```

This starts the actual stdio proxy, performs MCP discovery, reads three tools and checks that generation and project renaming are denied. It makes no model request and no payment.

## Compatibility layer and limits

The current development server announces names without full input schemas and returns domain objects rather than standard MCP `CallToolResult` blocks. `mcp-compatibility.ts` enriches the remote tool list using [generated schemas](./schemas) and wraps results in text plus `structuredContent`. It intersects the local catalog with the remote list; it does not claim the remote server implements absent tools.

The bridge uses the installed SDK's `NostrMCPProxy`, `StdioServerTransport` and stable private signer. The current service accepts transparent CEP-8 negotiation; the example supplies no payment handlers and does not expose `top_up`, faucet, publication or operator tools. No wallet is connected to it. It is a repository compatibility example, not a separately published MCP package.

## Priced continuation V2 negotiation

V2 continuation is deliberately absent from the default V1 announcement and
`tools/list` result. A client that implements the migration described in
[Issue #94](https://github.com/napplet/cvm/issues/94) must request version
`v2` on every discovery or invocation with both of these matching facts:

- MCP metadata: `_meta.nappletCvm.pricedContinuation: "v2"`
- signed ContextVM request-event tag: `["cvm", "napplet-cvm.priced-continuation", "v2"]`

The CVM enables `prepare_resume` and `resume_session_v2` only when its sealed
production facade is bound and both facts match. A missing, forged, mismatched,
or unsupported version is rejected; it never silently falls back from a V2
request. Existing V1 clients omit both fields and retain their original
discovery schemas and behavior. The tag is required because `_meta` alone is
not a signed capability.

## Enable generation deliberately

Set `CVM_MCP_ALLOW_GENERATION=1` in the host environment to additionally expose `funded_admission`, `start_session`, `revise_session` and `resume_session`. Existing account funds and valid admission/approval references are still required. The bridge's key identifies its account; funding a different browser key will not fund it.

Implement [the funding workflow](./workflow) for that same signer, or adapt the example to an already authorized signer. Use host approval for spending actions, preserve idempotency keys and set adequate request timeouts. The bridge does not silently top up, retry generation or publish on your behalf. Domain statuses remain visible in the result; `usage_unknown` is not an MCP transport success that authorizes another request.
