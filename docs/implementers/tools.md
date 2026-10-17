# Tool reference

This is the tool surface of the current repository. **Core** means a transport-neutral domain capability; **development** means the local composition supplies the implementation. Optional capabilities can be listed yet refuse requests when their facade is absent.

| Tool | Purpose | Important arguments / result |
| --- | --- | --- |
| `account_status` | Owner's balances and work | `{}`; decimal balances, top-ups/admissions/sessions |
| `top_up` | Separate funding | `idempotencyKey`, `pmi`, `mode`, `amount`, optional `topUpId`; payment tags also required |
| `funded_admission` | Capacity and cap reservation | `idempotencyKey`, `requestedCap`, `unit: "sat"`; accepted reference or refusal |
| `start_session` | First generation or development pending draft | Bounded `idea`, `maximum`, key, admission or `mode: "pre_admission"`; optional `remixReference` |
| `revise_session` | Next metered action | Session, admission, `expectedVersion`, maximum, key, bounded `revision` |
| `resume_session` | Explicit exact-action continuation | Checkpoint/version, pending reference/fingerprint, key, approval and funding/cap reference |
| `session_status` | Durable state and billing | `sessionId`, optional billing page; or pending-action checkpoint |
| `preview` | Verified artifact descriptor/review | `action`, session/artifact IDs and runtime variant |
| `publication` | Promoted publication workflow | Intent/consent, signed manifest submission, status/reconcile; unavailable in default development composition |
| `service_info` | Development availability, ceilings and estimates | `{}`; provider label, current ceilings, availability, caller-scoped `estimates` |
| `development_faucet` | Local test Cashu | `amount`; runtime cap is 10,000 test sats, no real value |
| `projects` | Private project list/read/rename/costs | `action`; list accepts stage, limit 1–50, cursor; get/rename/costs use ID; costs accepts limit and cursor |
| `remix_import` | Prepare a verified remix basis | Signed `event`, `naddr`, optional `assetUploaded`; or `action: "asset_part"` for bounded staging; returns owned remix reference |
| `development_publication` | Local publishing implementation | `preview`, `lookup`, `metadata`, `prepare`, `save`, `submit`, `status`, `reconcile`, `republish` |
| `operation_diagnostic` | Bounded owned operation failure | `operationId`; safe diagnostic or unavailable |
| `cvm_admin` | Operator configuration and jobs | Operator signer only; status, accounts, rates, jobs and job details |

See [complete structural input schemas](./schemas) for unions, required fields and bounds. Ordinary callers must not pass `principal` or an owner override. `publisher` in a publication preparation selects the eventual event signer; it does not grant access to someone else's artifact.

## Project and request costs

Call `projects` with `{ "action": "costs", "id": "<session ID>", "limit": 20 }`. The signed request identity must own the session; there is no owner override. Pass `after: nextCursor` for older requests. Cursors are valid only within the same owned session. The response is `{ status: "ok", costs }` or `not_found_or_denied`.

`costs` contains `unit: "test_sat"`, `sessionId`, `total: { confirmed, pending, requests }`, newest-first `requests`, and `nextCursor`. The total is cumulative committed session spend, independent of page size. `pending` counts actions without a confirmed charge. Request `charge` is a decimal string or `null`; never coerce `null` to zero. Failed actions with a charge remain in the total. Replay, list and status reads do not charge again.

Each request includes a stable ID and request key, ordinal, kind, bounded prompt (nullable for old records), outcome, verified version, creation time, maximum, and usage lines. Lines contain token dimension, units, saved rational rate (`numerator`/`denominator`) and integer charge. They are returned only when their sum matches the committed debit. Missing breakdowns do not invalidate the recorded charge. Provider account identifiers, credentials and raw provider responses are omitted. Project `list`/`get` also return the same `spend` summary for cards.

## Generation estimates

`service_info.estimates` contains `unit: "test_sat"`, `windowDays: 30`, and nullable `create`/`revise` estimates. Each estimate has `samples`, `basis` (`create`, `revise`, or `all`), a decimal-string `cost` range and integer `seconds` range, both with `low`/`high`. A null estimate means no eligible history; a null/missing `estimates` field means estimates are unavailable. Clients must still allow ordinary generation when estimates are unavailable.

Only the verified request identity's successful actions at the current runtime profile and price card are considered. The latest 60 candidates from 30 days are examined; up to 30 matching action types are used, with all-build fallback. Reconciled actions and nonpositive or over-one-hour durations are excluded. Observed cost and duration bounds are padded by 25%; cost is capped at the action ceiling and time rounded outward to five seconds (minimum displayed range 5–10 seconds). This is a historical heuristic, not a statistical confidence interval or prompt-specific quote. No provider credentials or job records are included.

Keep time guidance separate from durable stage progress. Suppress the ETA during stale/recovered requests and stop the countdown at completion or failure. Confirmed charges come from action results, never from estimates.

## Project pagination

```json
{ "action": "list", "limit": 20, "stage": "verified" }
```

A successful result contains `projects` and nullable `nextCursor`. Supply that cursor as `after` on the next page. Stages are `pending`, `active`, `verified`, `published`, `failed`, `unconfirmed` and `expired`. Omit `stage` for all stages. Use each project's `sessionId` or `checkpointId` to open the appropriate workflow.

`not_found_or_denied` intentionally does not reveal whether another identity's resource exists. A valid known project ID still requires the original owner signature.

## Development publication preparation

First call `lookup` with `sessionId`, `artifactId` and `publisher`. Its `current` and `latestPublished` records restore this version’s attempt and the most recent published version for that signer. The CVM checks session ownership using the signed request identity; `publisher` is only a filter. CVM previews are excluded.

Before preparing a new draft, call `metadata` with `sessionId` and `artifactId`. The signed CVM caller must own that exact artifact/session. The result includes bounded `title` (120 characters), `description` (500), `basis` (`manifest`, `project`, `fallback`), verified metadata `tags`, `files`, artifact ID and version. This action is read-only and makes no model request. Prefer manifest metadata; older generic titles fall back to the saved project. Interpret legacy `requires` and current `R`/`O` declarations without inferring optionality from their absence. See the [upstream manifest migration guide](https://napplet.run/docs/guide/event-migration.html).

Required preparation fields are `action: "prepare"`, `sessionId`, `artifactId`, `publisher` (hex pubkey), UUID `requestKey`, `title`, two to five distinct `servers` and one to five `relays`. Optional `description` is bounded to 500 characters; omitted descriptions use the CVM suggestion. Read the resulting template and files; do not construct a competing manifest. An existing signed attempt is reused for the same artifact and publisher.

After the client signs the template, call `save` with the returned UUID `id` and exact `event` before copying files. The CVM validates and durably retains that signature. Call `save` again with optional `fileResults` after the copy attempt; these are browser-reported receipts tied to the prepared servers and file paths, not independent server-side file checks. Copy retries recheck destination bytes. `submit` carries the same `id` and signed event once every file has verified receipts on at least two distinct origins. Additional failed destinations do not block submit. At least one selected relay must confirm for `published`; zero confirmations remain `unconfirmed`. Receipts preserve extra failures without downgrading success. The CVM repairs old `unconfirmed` attempts with stored positive relay receipts and enough verified copies on startup or owner lookup, without sending any event. Clients with enough saved complete-copy receipts can submit directly without re-copying. `status` reads the saved record; `reconcile` checks relay confirmation. Results include `signedEvent`, `fileResults`, `relayResults` and, on success, `publishedAt`, `address`, `eventId` and `url`.

To edit an unfinished signed attempt, use a new `prepare` request key with `replaces` set to its UUID and the revised metadata/destinations. Only the owner can replace a `prepared` or `unconfirmed` attempt. The CVM atomically marks the prior draft superseded and creates an unsigned replacement, carrying receipts for retained destinations. Prior signatures remain stored. The browser must obtain a fresh signature. Stale saves/submissions return `PUBLICATION_SUPERSEDED`; attempts to replace a published or currently sending draft return `PUBLICATION_EDIT_UNAVAILABLE`. `lookup` excludes superseded attempts. Ordinary retries without `replaces` continue to reuse the original event.

For an already published user applet, `republish` with its UUID `id` resends the exact stored signed event to its saved relays. This is owner-authorized and does not accept replacement event data or destinations. It bypasses the normal observe-first shortcut. It makes no model, upload or signer call and preserves the original event ID, address and publication timestamp. The returned `republication` contains `attemptedAt` and this attempt’s `relayResults`. Earlier positive receipts and published status survive a failed resend. Preview and unfinished records are rejected with `PUBLICATION_NOT_PUBLISHED`.

Project results include a nullable `publication` summary and `unpublishedChanges`. Publishing through another signer does not transfer the project to that signer. Only the identity proven by the signed CVM request can list its projects.

## Operator API

`cvm_admin` is intentionally excluded from the MCP example. Its verified caller must match the local operator key before any command is evaluated. Account responses are redacted; there is no key-read operation. See [private admin](../operators/providers) and [its source validator](https://github.com/napplet/cvm/blob/main/src/dev/cvm-operator.ts) before building an operator client.

## Remix HTML staging

When the verified HTML fits the 128 KB context limit, send `remix_import` parts with `action: "asset_part"`, `eventId`, `artifactHash`, zero-based `index`, `total` and canonical base64 `data`. Each decoded part is at most 8,000 bytes, with at most 16 parts; `index` must be less than `total`. Staged parts are owner-scoped, bounded and expired. Then send the signed manifest/naddr with `assetUploaded: true`. The service reassembles and verifies the bytes; staging alone is not acceptance of an applet.

The browser implementation in [remix-workspace.ts](https://github.com/napplet/cvm/blob/main/src/dev-ui/browser/remix-workspace.ts) shows the complete resolve, stage and prepare sequence. Prefer that flow over sending an arbitrary repository URL to the CVM.

### Restore a saved revision

The development `projects` tool accepts `{ action: "restore", id, artifactId, expectedVersion, idempotencyKey }`. Identity comes exclusively from the verified signed CVM request. Obtain `expectedVersion` from `session_status.session.version`; it is the concurrency version, not the selected artifact’s version.

A successful response has `status: "restored"`, `sessionVersion`, `artifactVersion`, `artifactId`, and `charge: "0"`. The command selects an owned, verified artifact with retained source, advances the session version, and records an immutable restoration. It makes no model call and creates no metered action. Retry with the same key and exact arguments to recover the same result. Stale commands return `STALE_SESSION_VERSION`; active or unresolved work returns `SESSION_NOT_REVISION_READY`.

After restoration, `session_status.session.latestVerifiedArtifact` identifies the **current** build, which may be older than other entries in `verifiedArtifacts`. Keep all those entries available for browsing. A subsequent `revise_session` uses the current build’s source. Reload status after restoring to obtain the authoritative current state; another client may already have changed it. Publication remains a separate explicit action.
