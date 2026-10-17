# Troubleshooting

Start with the visible status and execution details. Keep the project/session and operation IDs when asking the operator for help. Do not share private keys, `nbunksec`, OAuth tokens, API keys, wallet connection strings, or browser storage exports.

| Symptom | What it means | Next step |
| --- | --- | --- |
| Workspace not connected | The configured CVM or relay is unavailable. | Retry connection; ask the operator to check `dev.ts status`. |
| NIP-07 disabled | No compatible extension was detected. | Enable the extension or use NIP-46. |
| Reconnect signer | A saved signer could not be reached or unlocked. | Open/unlock it and reconnect; do not pair again unless the session was revoked. |
| No applets in Your applets | The selected identity owns no matching records. | Check This browser, stage filter, and which identity created the project. |
| No applets in Explore | Public events were not found on the queried outboxes. | Refresh, check the selected identity/network, or paste a known naddr directly. |
| Revision disabled | The session is not ready for that action. | Read the explanation beside the revision box. |
| Signing timed out | The requested signature was not received. | Reopen the signer and retry the publication step. |
| Some files could not be copied | One or more Blossom destinations failed. | Check each server URL and retry remaining steps. |

## Generation failures

**`CHATGPT_RESPONSE_TOO_LARGE`** is a response-processing limit, not evidence that OAuth expired. Check the operation details. An operator running an older build should update and restart it; signing in again is only useful when an authentication error is reported.

**`CHATGPT_GENERATION_TIMEOUT`** means the local model deadline elapsed. It does not mean sign-in expired.

**`USAGE_UNKNOWN` / outcome unconfirmed** means final provider acceptance or usage has not been established. A relay timeout may leave work running. Use **Check status** or the existing recovery action before retrying.

For a development subscription request that has durably ended with no recoverable source or receipt, the service can close the failed attempt and allow a new explicit revision. Previous verified versions remain available. Active requests and API-billed unknown outcomes are not automatically treated as free failures.

**Build or TypeScript/conformance failure** means model output did not pass the worker’s checks. Inspect the failed stage. Do not publish the failed output. Correct the request or ask the operator to inspect the safe job diagnostic.

## Reporting a problem

Include the action you took, expected behavior, visible error code, applet version, browser/version, and whether the provider label is fixture, subscription, or API. Operators can inspect the matching job in CVM admin. Repository bugs can be reported through [GitHub issues](https://github.com/napplet/cvm/issues/new).
