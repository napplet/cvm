# Local models

**There is currently no supported `baseURL`, Ollama, LM Studio or llama.cpp setting.** Adding an API key or changing the model text will not redirect requests to your computer. The configured API gateway validates two model IDs and calls a fixed OpenAI Responses URL.

You can run the whole development pipeline locally today with the deterministic fixture. For real local inference, implement a provider adapter; this is development work, not a missing installation command.

## Where to add support

Start with [ModelGateway](https://github.com/napplet/cvm/blob/main/src/model/model-gateway.ts), [the development gateway](https://github.com/napplet/cvm/blob/main/src/dev/development-model-gateway.ts), and [development composition](https://github.com/napplet/cvm/blob/main/src/dev/dev-composition.ts).

A local adapter needs to:

1. Accept a bounded source proposal request and return only permitted application files in the existing structured format.
2. Record an operation identity before dispatch and distinguish accepted, completed, definitely failed and unknown outcomes. A timeout is not permission to generate twice.
3. Supply trustworthy normalized usage, or introduce an explicitly named synthetic development accounting mode. Never invent provider usage to settle a real charge.
4. Bound prompt/output size, time and cancellation; preserve durable source/receipt recovery before starting the worker.
5. Add its provider identifier, model profile and price-card semantics to the validated contracts, then wire a private operator configuration and test it.

Keep model network access in the CVM's model gateway. The generated applet and isolated build worker should not receive model credentials or unrestricted network access. Do not give the worker host-network access to reach a local inference process.

## Acceptance tests for a new adapter

Test a real local completion, malformed/oversized output, missing usage, slow responses, cancellation, restart after dispatch, lookup-only recovery and duplicate commands. Run the resulting source through the same offline build, TypeScript checks and Chromium conformance as other providers.

Use the [schema amendment process](../developers/schema-changes) for new provider/pricing variants and the [compatible CVM guide](../developers/your-own-cvm) for the surrounding contract. The separate [production checklist](../runbooks/production-readiness-deferred) does not block development of this adapter.
