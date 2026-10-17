# Propose a schema change

Use the repository's [Schema amendment issue form](https://github.com/napplet/cvm/issues/new?template=schema-amendment.yml). This is the entry point for implementers and contributors, including people building another CVM.

## Write a concrete proposal

Describe the user/integrator problem and the exact contract affected. Include before/after request and response examples with synthetic values, the current revision/versions and a minimal alternative. Explain why the change belongs in this project's tool schema rather than an upstream NIP/CEP.

Cover these questions in the proposal:

1. Who can invoke it, and how is that authority proven by the signed request?
2. Does it create a cost, change a cap, affect idempotency or alter recovery after a crash?
3. Which existing strict clients or saved checkpoints will reject it?
4. How will old and new versions coexist or negotiate support? What is the migration and rollback path?
5. What conformance tests demonstrate the new behavior and preserve old behavior?

Do not attach real private keys, tokens, prompts or unpublished user projects. A schema example should be executable against a fixture, not depend on private evidence.

## Review and implementation

Maintainers discuss the proposal in the issue and record the accepted compatibility decision there. An issue is not an accepted protocol amendment until that decision is made. For breaking changes, agree on migration/versioning before relying on the new behavior in another client.

The implementation PR should link the issue and change the authoritative Zod validator, adapter mapping, domain/storage handling and affected clients together. Add migrations where durable data changes; preserve old operation and pricing evidence. Regenerate the JSON catalog and update examples and guides.

## Completion checklist

- The changed schema and its authority semantics are explicit.
- Unknown/old fields and new union variants have defined behavior.
- Old saved actions either remain compatible or fail with an actionable, safe reason.
- Identity isolation, duplicate delivery, stale versions and recovery tests pass.
- Native CVM and MCP example contracts still work, or their version change is documented.
- Documentation, generated catalog, issue decision and PR description agree.

The current public surface is project-specific. An accepted change here does not amend ContextVM or Nostr automatically. Upstream standards changes need their own proposal and cross-link.
