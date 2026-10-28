# Schemas and examples

[Download the JSON schema catalog](/contracts/napplet-cvm-v1.json).

The catalog includes all 17 tool input schemas, session action/status and cap-approval results, development progress, and model-profile/price-card configuration. It is generated from the **same Zod validators used by the service**, rather than a second handwritten API specification.

```sh
bun docs/scripts/export-contracts.ts
bun docs/scripts/export-contracts.ts --check
```

Run these from the repository root with its dependencies installed. CI rejects a stale catalog. The `napplet-cvm-contract-catalog-v1` label describes this documentation artifact, not a new negotiated wire version.

## Structural validation is not authorization

JSON Schema records shapes, enums, string patterns and many bounds. It cannot express every Zod refinement or state-dependent rule. The running service additionally verifies signatures, derives ownership, checks current capacity/funding, validates URL destinations, enforces pricing and checks durable versions/idempotency.

Examples: the top-up amount must fit the runtime's numeric bound; the development faucet caps issuance at 10,000; supported dimensions must have rates; source digests must match captured bytes; imported signed events must match their naddr and artifact hash. Passing a JSON Schema check does not bypass any of these.

## Wire envelope

```json
{
  "jsonrpc": "2.0",
  "id": "request-1",
  "method": "tools/call",
  "params": {
    "name": "projects",
    "arguments": { "action": "list", "limit": 20 }
  }
}
```

The SDK signs/encrypts this request and supplies request-event correlation. Do not fabricate `requestEventId` or trust a pubkey inside `arguments`.

```json
{
  "jsonrpc": "2.0",
  "id": "request-1",
  "result": { "status": "ok", "projects": [], "nextCursor": null }
}
```

These examples illustrate an empty owned project list. The MCP bridge wraps the domain result into standard content blocks for MCP hosts; native CVM clients receive the object above.

## Input schemas

Expand a tool to inspect its complete structural input. IDs in examples are illustrative; real IDs come from prior validated responses.

<script setup>
import catalog from '../public/contracts/napplet-cvm-v1.json';
</script>

<div class="contract-list">
  <details v-for="tool in catalog.tools" :key="tool.name">
    <summary><code>{{ tool.name }}</code> · {{ tool.scope }}</summary>
    <p>{{ tool.description }}</p>
    <pre><code>{{ JSON.stringify(tool.inputSchema, null, 2) }}</code></pre>
  </details>
</div>

<style scoped>
.contract-list details { border-bottom: 1px solid var(--vp-c-divider); padding: 16px 0; min-width: 0; }
.contract-list summary { cursor: pointer; overflow-wrap: anywhere; }
.contract-list pre { max-width: 100%; overflow: auto; font-size: 12px; line-height: 1.6; padding: 16px; background: var(--vp-c-bg-soft); }
</style>

For the rationale behind these choices and how to amend them, read [schema design](../developers/schema-design) and [schema changes](../developers/schema-changes).
