---
id: 261017-d8h
status: complete
---

Suggest publication title and description through signed CVM requests and expose advanced manifest data.

1. Inspect verified artifact metadata and source inputs. Add an owner-authorized read-only CVM metadata action that supplies bounded title/description suggestions from existing build evidence, with useful fallbacks for earlier builds. Avoid extra paid model requests or a public HTTP API.
2. Prefill editable title and description in publishing; carry edits through the CLI manifest, persisted publication and signing review. Keep required/optional capabilities read-only and visible in an advanced section before and after review/publication. Preserve signed templates and prevent late responses from overwriting edits or another version.
3. Verify metadata, ownership and signing behavior with focused tests and the publication journey; check responsive layout, refresh screenshot docs/contracts, activate while idle, then commit and push main.

User follow-up: saved copies must offer an explicit continue action without repeating a failed extra upload. Allow editing an unfinished signed publication through a replacement draft with a fresh signature, preserving the prior envelope and preventing stale submissions. Explain relay confirmation separately from file propagation. Verify replacement ownership, old-event rejection and unchanged signatures on ordinary continuation.

Execute gsd-quick inline; preserve existing unrelated files and production deferrals.
