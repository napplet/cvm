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
| `service_info` | Development availability and ceilings | `{}`; provider label, current ceilings, availability |
| `development_faucet` | Local test Cashu | `amount`; runtime cap is 10,000 test sats, no real value |
| `projects` | Private project list/read/rename | `action`; list accepts stage, limit 1–50, cursor; get/rename use ID |
| `remix_import` | Prepare a verified remix basis | Signed `event`, `naddr`, optional `assetUploaded`; or `action: "asset_part"` for bounded staging; returns owned remix reference |
| `development_publication` | Local publishing implementation | `preview`, `lookup`, `prepare`, `save`, `submit`, `status`, `reconcile` |
| `operation_diagnostic` | Bounded owned operation failure | `operationId`; safe diagnostic or unavailable |
| `cvm_admin` | Operator configuration and jobs | Operator signer only; status, accounts, rates, jobs and job details |

See [complete structural input schemas](./schemas) for unions, required fields and bounds. Ordinary callers must not pass `principal` or an owner override. `publisher` in a publication preparation selects the eventual event signer; it does not grant access to someone else's artifact.

## Project pagination

```json
{ "action": "list", "limit": 20, "stage": "verified" }
```

A successful result contains `projects` and nullable `nextCursor`. Supply that cursor as `after` on the next page. Stages are `pending`, `active`, `verified`, `published`, `failed`, `unconfirmed` and `expired`. Omit `stage` for all stages. Use each project's `sessionId` or `checkpointId` to open the appropriate workflow.

`not_found_or_denied` intentionally does not reveal whether another identity's resource exists. A valid known project ID still requires the original owner signature.

## Development publication preparation

First call `lookup` with `sessionId`, `artifactId` and `publisher`. Its `current` and `latestPublished` records restore this version’s attempt and the most recent published version for that signer. The CVM checks session ownership using the signed request identity; `publisher` is only a filter. CVM previews are excluded.

Required preparation fields are `action: "prepare"`, `sessionId`, `artifactId`, `publisher` (hex pubkey), UUID `requestKey`, `title` and one to five `servers` and `relays`. Read the resulting template and files; do not construct a competing manifest. An existing signed attempt is reused for the same artifact and publisher.

After the client signs the template, call `save` with the returned UUID `id` and exact `event` before copying files. The CVM validates and durably retains that signature. Call `save` again with optional `fileResults` after the copy attempt; these are browser-reported receipts tied to the prepared servers and file paths, not independent server-side file checks. Recheck destination bytes before retrying. `submit` carries the same `id` and signed event after all copies pass. `status` reads the saved record; `reconcile` checks relay confirmation. Results include `signedEvent`, `fileResults`, `relayResults` and, on success, `publishedAt`, `address`, `eventId` and `url`.

Project results include a nullable `publication` summary and `unpublishedChanges`. Publishing through another signer does not transfer the project to that signer. Only the identity proven by the signed CVM request can list its projects.

## Operator API

`cvm_admin` is intentionally excluded from the MCP example. Its verified caller must match the local operator key before any command is evaluated. Account responses are redacted; there is no key-read operation. See [private admin](../operators/providers) and [its source validator](https://github.com/napplet/cvm/blob/main/src/dev/cvm-operator.ts) before building an operator client.

## Remix HTML staging

When the verified HTML fits the 128 KB context limit, send `remix_import` parts with `action: "asset_part"`, `eventId`, `artifactHash`, zero-based `index`, `total` and canonical base64 `data`. Each decoded part is at most 8,000 bytes, with at most 16 parts; `index` must be less than `total`. Staged parts are owner-scoped, bounded and expired. Then send the signed manifest/naddr with `assetUploaded: true`. The service reassembles and verifies the bytes; staging alone is not acceptance of an applet.

The browser implementation in [remix-workspace.ts](https://github.com/napplet/cvm/blob/main/src/dev-ui/browser/remix-workspace.ts) shows the complete resolve, stage and prepare sequence. Prefer that flow over sending an arbitrary repository URL to the CVM.
