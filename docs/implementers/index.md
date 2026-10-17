# Integrate the CVM

Use the CVM from a static browser application, a TypeScript process, or an MCP-capable agent host. There is no HTTP endpoint for generation or account lookup.

| Integration | Transport | Guide |
| --- | --- | --- |
| Website or app | Signed/encrypted ContextVM over Nostr | [Connect with TypeScript](./connect) |
| MCP desktop/agent host | Local stdio proxy → ContextVM → CVM | [Use from an MCP client](./mcp) |
| Another service | Stable caller signer and the same tool commands | [Generation workflow](./workflow) |
| A replacement CVM | Implement the contracts and invariants | [Build a compatible CVM](../developers/your-own-cvm) |

The checked-in examples target **`@contextvm/sdk` 0.13.10** and **`@contextvm/mcp-sdk` 1.30.0**, the versions installed by this repository. The upstream SDK has newer releases; do not mix examples from a different version without interoperability tests. See the [official SDK overview](https://docs.contextvm.org/reference/ts-sdk/quick-overview/).

Start with read-only calls. Then implement funding, explicit action approval, idempotency, recovery and publication as separate steps. A successful transport response can still be a domain refusal or an unconfirmed outcome.
