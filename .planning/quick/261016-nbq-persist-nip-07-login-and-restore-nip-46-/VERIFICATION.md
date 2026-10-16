# Verification

- `bun tests/dev-ui/persistent-identity.e2e.ts` — passed. Public-key-only NIP-07 reload; same-origin new tabs; cross-tab sign-out; locked/missing/delayed extension; canceled restore cannot undo logout; malformed records removed; NIP-46 QR pairing, applesauce nbunksec round trip, same-client reconnect, verified event signing, bounded offline recovery, changed-user rejection, and leased signer continuity.
- `bun tests/dev-ui/returning-projects.e2e.ts` — passed against isolated local PostgreSQL, relay, mint, NWC, CVM and worker with fixture inference. Added signed-owner preview restoration after reload, without another model request.
- `bun tests/dev-ui/static-cvm-publication.e2e.ts` — passed. Static subdirectory on a separate origin, real encrypted NIP-46 fixture, signing/Blossom mirroring/publication, CVM restart, retained remote sign-in and enabled publishing after reload; no additional inference.
- `bun tests/dev-ui/responsive-workspace.e2e.ts` — all 304 checks passed across 19 viewport sizes, including the sign-in dialog.
- `bunx tsc --noEmit` — existing baseline remains 424 diagnostics; no additional file/error-code counts and no errors in the new identity files/test. This is not a clean full-repository typecheck.
- `git diff --check` — passed.
- Default service smoke — ready at http://127.0.0.1:49371 (PID 89832), ChatGPT OAuth mode retained. Fresh Chromium connected with the new nbunksec/reconnect bundle and zero browser errors. Zero active actions confirmed before restart; no model request made.

The focused browser test exposed an asynchronous relay CLOSE/socket teardown race. Awaiting the signer close before pool destruction resolved it; the final identity and publication journeys have no browser errors.

No real subscription model request was made by this task. Provider credentials remain private to the CVM. Browser identity credentials never enter CVM arguments or generated applets. Actual external signer apps are represented by protocol-compatible cryptographic fixtures in these checks.
