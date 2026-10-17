# Accounts and providers

Model configuration belongs to the **CVM's private admin**, not the public website. People using the workspace see the active provider label and its availability; they never need your model account or key.

## Choose a mode

| Mode | What it runs | What you need |
| --- | --- | --- |
| Deterministic fixture | Sample model output through the real local pipeline | Nothing beyond the local installation |
| ChatGPT subscription | Real generation using the operator's OAuth account | Interactive sign-in in private admin; available account/model access |
| Configured OpenAI Responses | Real, billable API requests | API account, accepted model and validated pricing/profile evidence |
| Local model | No built-in endpoint setting yet | A provider adapter change; [implementation path](./local-models) |

Local Cashu/NWC test sats are separate from provider usage in every mode. An API key can incur real API charges even though the app's local balance uses test sats.

## Use your ChatGPT subscription

1. Start the CVM, then run `bun scripts/open-dev-admin.ts` from the repository root. For a named instance, prefix it with the same `NAPPLET_CVM_DEV_INSTANCE` value.
2. In private admin, choose **Continue with ChatGPT** and complete the browser authorization.
3. Select the account and an available model. Selection applies automatically. Check the workspace provider label before generating.
4. Use the jobs view to inspect pending, active and finished actions, including individual job details.

The CVM keeps OAuth state in its private local directory across restarts. Repeated sign-in is not part of the normal development loop. A genuine authentication failure can require reconnecting; a timeout, large response or worker failure does not by itself mean you are signed out.

The admin opener passes a local operator credential in a URL fragment, which the page removes. Do not copy that launch URL to others. **Lock admin** ends that browser's admin session. The public static export excludes the admin page.

Model availability is confirmed by a successful request. A listed model is not a guarantee of permission or remaining subscription allowance. Manage subscription limits in the account's ChatGPT settings; API-credit balances are separate.

## Use an API account

Private admin accepts an account label/key, model, model profile, price card and captured price sources. The current adapter accepts `gpt-5-mini` or `gpt-5-mini-2025-08-07` at the fixed OpenAI Responses endpoint. It does not accept arbitrary OpenAI-compatible endpoints.

You can also supply these five environment variables before launching:

| Variable | Value |
| --- | --- |
| `OPENAI_API_KEY` | Private API key |
| `NAPPLET_CVM_OPENAI_MODEL` | One of the accepted model identifiers above |
| `NAPPLET_CVM_OPENAI_PROFILE` | JSON model profile |
| `NAPPLET_CVM_OPENAI_PRICE_CARD` | JSON price card |
| `NAPPLET_CVM_OPENAI_PRICE_SOURCES` | JSON captured provider and conversion evidence |

The three configuration objects are **JSON values, not file paths**. All five variables must be present together; partial or invalid configuration fails startup. An account selected in private admin takes precedence over the environment configuration.

Use the [downloadable schema catalog](../implementers/schemas) for `operatorConfiguration.modelProfile` and `priceCard`. The source-of-truth validator is [development-model-gateway.ts](https://github.com/napplet/cvm/blob/main/src/dev/development-model-gateway.ts). To prepare evidence:

1. Capture the provider's applicable price document and the conversion source used for sat rates. Record exact bytes and their SHA-256 digests, URLs, observation/effective times and freshness deadlines.
2. Set each `priceSources.provider` and `priceSources.conversion` object to `{ "url": "…", "capturedBytes": "…", "sha256": "…" }`; each must match its price-card provenance.
3. Use `provider: "openai_responses"`, card `kind: "source_attributed_provider"`, matching model/profile/card IDs, positive integer-string rational rates and a current validity window. A rate is sats per usage unit; all supported dimensions must be priced.
4. Set explicit input/output maxima in the profile, within the card's ceilings. `selection` is currently the literal `unselected`; it is a validated contract field, not the admin selection switch.
5. Save the account and select it while no action is active. Confirm the configured-provider label and review the authorization maximum before a paid test.

Do not reuse fixture rates as real-provider price evidence. The validator checks freshness, matching digests and bounds; it cannot decide whether your captured commercial pricing and conversion choice are appropriate.

## Change rates or models

Private admin allows synthetic development rates. Real API pricing requires a new validated price card/evidence set. Active work blocks configuration changes, and saved actions retain their original pricing/model pins. An update is not permission to change an existing operation's accounting.
