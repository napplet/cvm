# Why this schema?

The schemas make **authority, cost and recovery explicit** at boundaries where an untrusted client or generated program meets durable effects. They intentionally carry less information than the internal store.

| Choice | Reason | What an implementer must preserve |
| --- | --- | --- |
| Strict object shapes | Catch misspelled fields and accidental authority injection | Reject undeclared fields instead of silently accepting an owner override |
| Principal injected by adapter | Signed event identity is the proof of account ownership | Never trust a client-supplied npub as authorization |
| Decimal strings for sats/usage | Avoid floating-point rounding and JSON integer portability problems | Canonical syntax, exact arithmetic and explicit range checks |
| Rational rates and ceiling rounding | Make a receipt's charge reproducible | Versioned card/profile, supported dimensions and captured pricing evidence |
| Separate top-up and generation | Money arrival is not consent to run code or spend it | Reserve/admit and explicitly approve each intended action |
| `idempotencyKey` plus fingerprint | Relays and reconnects can deliver a request more than once | Durable key scope and payload consistency across restarts |
| `expectedVersion` | Prevent concurrent/stale edits from silently overwriting work | Compare version atomically with action acceptance |
| Opaque references | Keep credentials, storage paths and private archives out of clients | Revalidate ownership/state on every dereference |
| Discriminated `status` / `action` unions | Make next steps and failure states machine-readable | Handle each supported branch; don't flatten unknown outcomes into failure |
| Separate dispatch and lookup | Recovery must not create another billable provider request | Lookup-only handling of an already recorded operation |
| Exact pending fingerprint and approval | Prevent a checkpoint from resuming different work | Bind payload, maximum, owner, versions and compatibility pins |
| User-signed prepared manifest | Preserve user custody while the CVM prepares verified deployment metadata | Accept only the exact approved event and verified artifact |
| Bounded diagnostics | Give useful failure information without leaking source or secrets | Project safe codes/evidence references, not raw provider errors |

## Three kinds of identity

A **JSON-RPC ID** correlates one request/reply. A **signed Nostr event ID** binds the actual verified wire request. A **business idempotency key** names the intended durable operation. These solve different problems; none can replace the others.

An artifact hash identifies immutable bytes, not permission to read a private project. A session/version identifies a point in the workflow, not a fresh authorization to spend. Keep these distinctions in any alternate implementation.

## State has consequences

`usage_unknown` means evidence is missing after a potentially accepted dispatch. It is not an error string to clear with a retry. `needs_top_up` describes a saved action awaiting funding/cap approval. `verified` means an artifact passed the required checks. `published` additionally concerns signed-event and destination observations; a successful build does not establish publication.

Current development subscription recovery has a narrowly scoped waiver policy for ended, unrecoverable attempts. It preserves the original provider observation and dispatch fence while allowing a new user-approved revision. That policy is not a general real-money reconciliation rule.

## Schema versions and compatibility

The repository pins policy, model profile, price card, toolchain and checkpoint formats independently. A saved action can reject incompatible pins even when its JSON still parses. The documentation catalog has its own format version; changing it does not negotiate a new CVM protocol.

Strict readers make even some additive fields incompatible. Before adding a new status or field, inspect all validators, persisted rows, browser code and the MCP bridge. Design the migration/negotiation first; use [the amendment process](./schema-changes).
