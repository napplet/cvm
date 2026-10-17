# Costs and limits

## Development test sats are not model credits

The local Cashu and NWC services use test money. The workspace can fund these automatically to exercise the payment flow. Those amounts do not buy ChatGPT allowance or API credits.

| Mode | Model request | Accounting |
| --- | --- | --- |
| Deterministic fixture | No external model request | Synthetic local test charge. |
| ChatGPT subscription development | Uses the operator’s authorized subscription account | Actual usage counts with local test-sat rates; upstream subscription usage may count. |
| Configured API provider | Uses the operator’s API credentials | Billable provider usage with configured, source-attributed price evidence. |

The service advertises the current action ceiling. Review the maximum shown for your action rather than relying on a number from an old screenshot; operator settings can change rates for new work.

## Available, held, and spent

Admission reserves capacity and holds funds before generation. A held maximum is not the same as a settled charge. The available balance can fall by more than the final model charge while a hold remains in place.

Accepted actions retain their original price/profile. Changing the operator’s provider or rates affects new actions. Saved pending actions remain bound to their original configuration.

## Bounds you may encounter

- Workspace ideas and revisions: up to 512 characters. Direct CVM requests: up to 4,000 characters.
- One focused, sandboxed applet per project.
- Published HTML download for remix: up to 2 MB; HTML model context: up to 128 KB.
- Model and worker deadlines are finite. A slow or interrupted request may stop without a new verified version.
- A local maximum does not enforce a per-request output-token cap on the ChatGPT subscription endpoint.

Do not assume an interrupted request used no subscription allowance. The workspace may waive its local test charge while the provider still records usage.

For details about pauses and recovery, see [troubleshooting](./troubleshooting). Operators should read [accounts and providers](/operators/providers).
