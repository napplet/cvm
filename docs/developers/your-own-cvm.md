# Build a compatible CVM

You can implement the service in another process, language or deployment while retaining the external contract. Start with a clearly declared subset and reject unavailable tools. Do not claim a billing, preview or publication capability until its authority and evidence exist.

## 1. Implement the transport edge

Use a ContextVM server transport or a compatible implementation. Require signed/encrypted requests, verify the inner event and correlate the response to that exact request. Derive the principal from the verified event public key, never a body field.

Support JSON-RPC initialization, tool discovery and calls. The current service uses MCP protocol version `2024-11-05` during initialization and domain-result objects on the wire. If you expose standard MCP content blocks instead, state that explicitly and test the client adapter; see [the compatibility bridge](../implementers/mcp).

The current bridge is [small enough to inspect](https://github.com/napplet/cvm/blob/main/src/contextvm/sdk-bridge.ts). In-memory SDK correlation is a transport concern. Persist business idempotency independently so a service restart cannot repeat a debit or provider call.

## 2. Reuse the command meanings

Use the [schema catalog](../implementers/schemas) as a structural starting point and [tool workflow](../implementers/workflow) for order/semantics. Implement core tools first; development faucet, private admin and the local publication facade are composition-specific extensions.

Keep these invariants:

- A caller can read/change only resources authorized by its verified identity.
- Money uses exact integer/rational arithmetic and approved caps; admission precedes effects.
- Duplicate delivery returns/reconciles the original operation; changed input under the same key is rejected.
- Expected versions prevent stale revisions from racing newer work.
- Unknown provider outcomes remain distinct from proven non-acceptance.
- Resume requires explicit approval of the exact pending action and compatible pinned environment.
- Preview/publication consume verified immutable artifacts; publication requires the user's exact signature.

## 3. Supply concrete ports

Implement storage transactions and migrations, capacity/worker leases, model dispatch/lookup, artifact/checkpoint storage, verification and publication adapters. See `src/persistence/`, `src/model/`, `src/continuity/` and `src/publication/`.

Use the project's pinned napplet scaffold/CLI contract instead of inventing a manifest. Run real browser conformance for the generated output. A source-only “success” response is not a verified napplet.

For a first development slice, a deterministic model gateway and local services provide a reproducible path. A real provider additionally needs bounded usage and recovery evidence. A [local-model adapter](../operators/local-models) must solve those concerns too.

## 4. Prove interoperability

Run the [read-only native and MCP examples](../implementers/connect) against your relay/key. Then add signed tests for both funding rails, admission, generate/revise, duplicate delivery, stale version, crash/restart, uncertain receipt, checkpoint resume, artifact denial and user-signed publication. Test a second identity attempting to access the first one's resources.

Compatibility requires behavior as well as matching JSON shapes. Preserve bounded errors, money semantics, exact operation recovery and owner scoping. Document unsupported tools/runtime variants and the production capabilities you have actually measured.

## 5. Propose extensions upstream

Use [schema amendments](./schema-changes) for new fields, provider modes, lifecycle states or protocols. The current catalog is project-owned; it is not a universal ContextVM standard. Keep project changes separate from proposals to ContextVM CEPs or Nostr NIPs, and link relevant upstream discussions when needed.
