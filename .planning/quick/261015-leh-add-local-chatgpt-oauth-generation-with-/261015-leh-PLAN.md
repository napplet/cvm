---
id: 261015-leh
mode: quick
status: complete
---

# Local ChatGPT OAuth generation

User authorized the proposed development-only integration on 2026-10-15. Production remains deferred. Execute inline through the GSD quick workflow.

1. Add a local OAuth client using OpenAI's documented dynamic registration, PKCE, state/nonce validation, verified ID tokens, protected atomic credential storage, serialized rotating refresh, account model discovery, and logout. Expose only safe status through loopback control routes protected against cross-origin requests. Credentials never enter the GUI, logs, SQL, or generated workspace.
2. Add a separately identified ChatGPT development provider with streamed Responses (`store:false`), bounded output, durable original-operation fencing and completed observations, authorized prior sources, real reported usage, and explicitly synthetic test-credit pricing. Integrate model selection and sign-in in the GUI while retaining deterministic E2E defaults and API-key mode.
3. Verify OAuth failures/refresh/replay, stream completion/error/disconnect, secret boundaries, and browser generation/revision through the actual local relay/SQL/worker/preview using injected OAuth fixtures. Add an opt-in live smoke path, document setup and limitations, update STATE, and commit.

Acceptance: one browser sign-in enables real local generation; available models come from the account catalog; restarting preserves settings/credentials; ambiguous inference is never redispatched automatically; actual usage is distinguished from test charges; existing deterministic tests pass. Real account authorization must be completed by the user and cannot be claimed from fixtures.

Official references inspected 2026-10-15:
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/siwc/token-sharing-open-source/token-reference
- https://developers.openai.com/siwc/website (ID-token validation only; use local dynamic registration, not commercial registration)

Implementation review: keep OAuth configuration in the development composition; add distinct provider/card identifiers instead of labeling subscription usage as paid API usage; use native crypto to avoid changing the pinned root dependency manifests. Preserve all unrelated working-tree files.
