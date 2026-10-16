---
status: passed
verified: 2026-10-16
method: inline
---

# Development verification

| Acceptance | Evidence | Result |
|---|---|---|
| Static public site; private provider controls | Separate origin and subdirectory, public HTTP controls absent, signed admin allowlist tests | Passed |
| Sign in during generation, default QR, all three methods | static-cvm-publication browser journey including real NIP-46 local signer | Passed |
| Contextual inline publishing | Step 4, no header Publish/modal, signature review and progress | Passed |
| CVM preview sharing and restricted Blossom | Real blobs/event/naddr, unauthorized uploads/mirrors rejected | Passed |
| User destination handling | Manual and discovered Blossom/NIP-65 lists, chips, invalid URL rejection, no fallback to CVM relay, failed propagation blocks event | Passed |
| Exact signed publication and relay confirmation | Tamper and owner denial, mirror hash checks, exact event replay/readback/restart, DNS pinning/TLS hostname/redirect tests | Passed |
| Private durable project listing | Signed owner list/get/rename/cursor, cross-owner denial, forged request denial, pending/active/verified stages | Passed |
| Returning account in another browser | Fresh browser plus CVM restart, same NIP-07 identity, opens verified preview with no new inference | Passed |
| Existing anonymous project after sign-in | Start with browser key, emulate legacy unbound account, sign in while model stream is held, list both identities, automatic Building→Ready update, reopen original artifact | Passed |
| Integrated collection page | Direct hash route, no project dialog, shared header, back/forward, uninterrupted build and saved draft, mobile overflow check | Passed |
| Existing product behavior | Generation, five fixture inferences across revision cases, last-good preview after failed revision, exact recovery, responsiveness and keyboard | Passed |

Commands and local result artifacts:

- `bun test tests/dev/publication-relay-tls.test.ts tests/dev/publication-destinations.test.ts tests/contextvm/verified-project-identity.test.ts tests/dev/cvm-operator.test.ts tests/dev/cvm-blossom.test.ts tests/contextvm/adapter.test.ts tests/contextvm/publication-adapter.test.ts tests/dev/chatgpt-oauth.test.ts tests/dev/chatgpt-model-gateway.test.ts tests/dev/chatgpt-diagnostic.test.ts tests/dev-ui/development-progress.test.ts`: 70 pass, 445 assertions (`/tmp/cvm-final-tests.log`).
- Identity/adapter/progress subset repeated after collection changes: 16 pass, 134 assertions (`/tmp/cvm-project-page-unit.log`).
- `bun tests/dev-ui/returning-projects.e2e.ts`: passed (`/tmp/cvm-returning-v3.log`). An earlier attempt reached the fresh-browser step but the test incorrectly waited for a now-hidden workspace label to be visible; corrected to wait for its connected state.
- `bun tests/dev-ui/product-workspace.e2e.ts`: passed (`/tmp/cvm-product-page-v1.log`). The logged failed verification command is the intentional failed-revision fixture.
- `bun tests/dev-ui/static-cvm-publication.e2e.ts`: passed (`/tmp/cvm-static-page-v1.log`).
- `bun scripts/build-workspace.ts` and `bun scripts/build-publish-vendor.ts`: passed.
- `bunx tsc --noEmit`: 424 existing diagnostics, no new normalized signatures against the pre-change baseline (`/tmp/cvm-project-page-typecheck.log`). Not a clean global typecheck.
- `node /tmp/cvm-page-smoke.mjs`: running default service passed direct route, no modal, draft preservation, back/forward and mobile checks.
- Desktop/mobile screenshots inspected: `/tmp/cvm-projects-desktop.png`, `/tmp/cvm-projects-mobile.png`.
- Root pins unchanged: package.json `cbcc433278d32391b075576ebd847ae30039f1d86ad229a149f5566856989f23`; bun.lock `8916ee4ec92924ae9e09bc4f315fd6656033812696e35a1b7785161d872c5ac3`.

No production certification, public user publication, or real model request was performed by these tests. Historical unknown operations remain fenced; the tests do not assert they completed.
