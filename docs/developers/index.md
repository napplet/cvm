# Contribute to napplet-cvm

Start with [local installation](../operators/quick-start), then choose the smallest layer that owns the change. The public interface is ContextVM; do not add an HTTP generation API to solve a client integration problem.

## First contribution

1. Read [architecture](./architecture) and the repository's [AGENTS.md](https://github.com/napplet/cvm/blob/main/AGENTS.md).
2. Reproduce the behavior with a focused test or the local workspace. Use fixture inference when a paid provider is not necessary.
3. Make the change with its boundary checks and relevant tests. Preserve other work in your checkout.
4. Update the affected user/operator/integrator guide. If a validator changes, regenerate the [schema catalog](../implementers/schemas).
5. Open a pull request explaining the concrete behavior, validation and compatibility implications. Link a [schema proposal](./schema-changes) for contract changes.

The project uses GSD planning artifacts for tracked development. Its AGENTS instructions require an appropriate GSD entry point before repository edits when working through an agent. See the repository's `.planning/` state for current work; product correctness comes from source/tests, not a plan's completion label.

## Useful starting points

| Change | Start with |
| --- | --- |
| Workspace UX, sign-in, progress | `src/dev-ui/`, browser e2e tests |
| Tool arguments or verified caller mapping | `src/contextvm/adapter.ts`, `sdk-bridge.ts` |
| Model provider or receipts | `src/model/`, development provider gateways |
| Ledger, replay or sessions | `src/funding/`, `src/phase-04/`, `src/persistence/` |
| Checkpoints and explicit resume | `src/continuity/` |
| Preview/publication contracts | `src/publication/`, development local publication |
| Docs | `docs/`; [maintenance guide](./documentation) |

Do not include `.local/`, browser identity exports, provider accounts, payment material or generated private artifacts in a PR. Use synthetic fixtures and bounded diagnostics.

## Review expectations

Tests should cover the failure boundary a change affects, especially identity spoofing, duplicate delivery, interrupted operations, stale versions and publication retries. Report skipped Docker/live-provider checks explicitly. A deterministic unit pass is not evidence of production latency or real payment settlement.

Use [testing](./testing) for commands and [schema design](./schema-design) for contract rationale. If you are building a separate implementation, continue to [Build a compatible CVM](./your-own-cvm).
