# Costs and limits

## Development test sats are not model credits

The local Cashu and NWC services use test money. The workspace can fund these automatically to exercise the payment flow. Those amounts do not buy ChatGPT allowance or API credits.

| Mode | Model request | Accounting |
| --- | --- | --- |
| Deterministic fixture | No external model request | Synthetic local test charge. |
| ChatGPT subscription development | Uses the operator’s authorized subscription account | Actual usage counts with local test-sat rates; upstream subscription usage may count. |
| Configured API provider | Uses the operator’s API credentials | Billable provider usage with configured, source-attributed price evidence. |

The service advertises the current action ceiling. Review the maximum shown for your action rather than relying on a number from an old screenshot; operator settings can change rates for new work.

## Estimates before you send

The build review and revision composer show **estimated cost** and **estimated time** separately from your maximum. These rough ranges come from your recent successful builds on the connected CVM with its current model configuration and rates. No extra model request is made to calculate them.

The CVM uses up to 30 matching runs from the past 30 days, preferring creation history for new applets and revision history for changes. If it needs to use your other successful builds, the label says “recent builds.” One or two runs are marked **limited history**. With no usable history, you see **Not enough history** and can still proceed.

These are guidelines, not a quote or deadline. Prompt complexity, retries within a build, service load and network delays can change the result. A different identity or operator configuration can mean starting without history again.

<GuideScreenshot name="setup" alt="Creation review with estimated cost, estimated time and a separate maximum test budget" caption="Compare the cost and time estimates before creating. The screenshot uses sample history; your CVM calculates its own ranges." />

During generation, the progress area shows elapsed time and approximate remaining time. If the request runs longer, it says **Taking longer than recent runs**. If updates stop, the time estimate pauses. Checking a saved request does not restart a countdown. A successful request shows its **actual charge**; it may differ from the estimate.

Estimated costs here are **test sats**, not API dollars or remaining ChatGPT subscription allowance. The maximum remains an accounting limit, not a prediction of what you will spend.

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
