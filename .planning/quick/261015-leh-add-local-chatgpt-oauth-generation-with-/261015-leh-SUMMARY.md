---
id: 261015-leh
mode: quick
status: complete
completed: 2026-10-15
implementation_commit: 48f5a0f
---

# Local ChatGPT OAuth generation

Implemented development-only ChatGPT sign-in and model selection in the execution GUI. Real account authorization is a user action; all automated OAuth/inference evidence below uses fixtures. Production remains deferred.

## Delivered

- Local dynamic OAuth registration with PKCE, browser-bound state, nonce, signed ID-token validation, account identity checks, and persisted registration IDs. Credentials live only in the selected instance's private `development-chatgpt` directory. Refresh rotation is serialized, token replacement is atomic, and sign-out clears all local tokens even when remote revocation cannot be confirmed.
- Account-derived model catalog, first-use explanation, explicit provider selection, active ChatGPT label, safe diagnostics, and Manage usage link. Default deterministic and configured API providers remain available through explicit selection. Generated artifacts and browser state never receive OAuth credentials.
- Streamed Responses adapter requiring `response.completed`, `store:false`, bounded bytes/time, owner-authorized revision source, durable dispatch claims, and persisted usage/source observations. Ambiguous operations are never automatically redispatched. Synthetic local test prices are a distinct provider/card type; actual token counts are preserved. No unsupported upstream output-token cap is claimed.
- Additive development migration, launcher mode/readiness/reset support, fixture browser suite in the full CI command, opt-in live smoke, README setup, and detailed recovery/credential/accounting documentation.

## Verification

- `bun test tests/dev/chatgpt-oauth.test.ts tests/dev/chatgpt-model-gateway.test.ts`: 23 passed, 97 assertions. Covers signature/claim/state/cookie failures, expired callback, private storage, restart, rotating/concurrent refresh, terminal/transient refresh errors, revocation failure, stream truncation/abort/size, source validation, immutable operation binding, and replay fencing. Log: `.local/chatgpt-unit-final.log`.
- `bun scripts/dev.ts test --case=full`: all ten cases passed. Includes real local Cashu/NWC, signed ContextVM relay traffic, PostgreSQL, Docker worker, verifier, artifact store, Paja, pending-action resume, revision/restart/replay, responsive layout, and security boundaries. Configured API mode explicitly skipped without credentials. Log: `.local/chatgpt-full-suite-rerun.log`.
- Final `--case=chatgpt-oauth` rerun passed after adding interaction with the third verified preview following a service restart. Exactly three fixture inference calls, three provider observations, and three user debits; replay added none. Browser traffic, DOM, storage and console excluded tokens; logout cleared them. Screenshots at 375/1280 pixels inspected. Log: `.local/chatgpt-browser-final.log`; images: `.local/development-gui-evidence/chatgpt-*.png`.
- Existing model/billing/ContextVM/local identity/artifact checks: 38 passed, 169 assertions. SQL model-proposal and metered-finalization checks passed; configured-pricing registration passed after the concurrency fix below.
- Live smoke without `--allow-chatgpt-usage` fails before starting any inference. Real ChatGPT sign-in/inference and remote CI were not run; the user can exercise them through the running GUI and documented opt-in command.
- Root package manifest and lockfile hashes remain unchanged. `git diff --check` passed.
- Restarted the default instance without resetting data. Launcher reports ready at `http://127.0.0.1:49371`; Chromium confirms the sign-in button is visible with no page errors. It remains in deterministic mode until the user selects ChatGPT.

## Findings and adjustments

- Existing immutable pricing registration could fail on a concurrent unique content-hash insert. Retry only the two known hash constraints, then revalidate the stored immutable row; its SQL regression passes.
- Initial broad suite encountered a Docker container with no assigned ephemeral port. Removed only that isolated test stack and reran successfully; no broad Docker cleanup or default-state reset occurred.
- Browser count assertions scope ledger debits to the user account, excluding the balancing treasury entry. Preview screenshots now wait for the final napplet to become interactive.
- Extended generation/revision/resume RPC waits to cover the bounded model call plus real worker verification.

## Usage and limits

Open the development URL, choose **Continue with ChatGPT**, authorize, choose a model, and select **Use ChatGPT plan**. After reload, **Connect**, fund with local test sats, and generate. Restart preserves the selected account/model. The displayed maximum caps local test charges; ChatGPT plan/app limits are managed in ChatGPT. Saved actions require their original account/model selection. No production authorization or provider-cost certification is implied.

Implementation: `48f5a0f` (`feat(dev): add ChatGPT OAuth generation and GUI sign-in`). Production plans 07-20/07-26 and milestone completion counts are unchanged. Unrelated untracked evidence and lockfiles were preserved.
