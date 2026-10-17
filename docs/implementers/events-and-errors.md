# Progress and errors

## Show activity without inventing certainty

The development CVM emits `notifications/development_progress` for admission, generation, revisions, resume, preview and remix import. Each notification includes `version: 1`, `requestId`, `tool`, `sequence`, timestamp, elapsed time, stage and state. Optional stream bytes show transport activity, not tokens or billable usage.

Match the pending request ID and tool, validate the payload and ignore duplicate/out-of-order sequence numbers. The repository's [progress contract](https://github.com/napplet/cvm/blob/main/src/dev-ui/progress-contract.ts) implements this. A heartbeat means the process is reporting activity; it is not a completed artifact or a settled charge.

Stages cover model response, source/usage recording, worker scaffolding, guidance installation, offline dependencies, build, TypeScript checks, Chromium conformance, deployment dry run, artifact sealing, CVM sharing and ledger settlement. States are `running`, `completed`, `failed` and `uncertain`.

After reconnecting, read `session_status`. Its durable timeline includes recorded source/provider, worker completion, verified artifact and ledger settlement. Live notifications may have been missed and should not be treated as the system of record.

## Interpret outcomes

| Outcome | Meaning | Client action |
| --- | --- | --- |
| JSON-RPC `-32602` | Invalid request, unsupported arguments or rejected boundary | Correct the request; do not loop automatically |
| `denied` / `not_found_or_denied` | Authorization, reference or state precondition failed | Check signer and references; do not probe another owner |
| `needs_top_up` | Funding/cap cannot cover the next authorized action | Show shortfall and exact pending approval; funding alone does not approve work |
| `completed` / `ACTION_COMMITTED` | Action and accounting committed | Save session/version/artifact references and show verified preview |
| `failed` / `WORKER_OR_ARTIFACT_FAILED` | Build or verification failed | Keep prior verified version; show the failed stage/diagnostic |
| `failed` / `MODEL_RESPONSE_INTERRUPTED` | Recoverable ended subscription attempt was closed | Preserve draft; let the user explicitly submit again |
| `usage_unknown` / `USAGE_UNKNOWN` | Submitted provider outcome is not confirmed | Read status/diagnostic; preserve identity and dispatch fence |
| `billing_invariant_failed` | Accounting evidence violated an invariant | Operator reconciliation; no automatic retry |
| `reconciliation_pending` | A boundary still needs evidence | Check the same operation later; don't create a duplicate |

Some tools return codes specific to their domain. Handle unknown codes conservatively and display a useful safe message, not raw provider response bodies.

## Provider diagnostics

`operation_diagnostic` returns bounded diagnostics only for the request owner's operation. Authentication, timeout, oversized response, connection failure and local recording failure are distinct categories. `CHATGPT_RESPONSE_TOO_LARGE` is a size limit, not a sign-in instruction. A transport timeout alone cannot establish whether the provider kept running.

Development subscription recovery can close a durably ended, unrecoverable attempt and waive its local test charge. It does not cancel upstream usage or retry generation. Active work, recoverable saved source and uncertain real API charges retain their recovery/reconciliation rules. See [operator recovery](../operators/operations#recover-a-failed-request).

## Preserve useful UI state

Keep the last verified preview, user's revision text, session/operation references and exact pending request while showing the failure. Display an actionable next step from durable status. Never erase a good applet simply because the latest revision failed, and never claim a job is still running solely because the browser is waiting.
