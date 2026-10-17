# Testing and evidence

Choose tests for the boundary you changed. Use deterministic inference for repeatable checks; live accounts are optional evidence and may consume real usage.

## Fast checks

```sh
bun install --frozen-lockfile
bun test tests/contextvm/
bun test tests/dev/cvm-operator.test.ts tests/dev-ui/development-progress.test.ts
bun docs/scripts/export-contracts.ts --check
bun test examples/contextvm/mcp-compatibility.test.ts
```

`bun test` runs the wider suite. Docker-dependent and configured-provider checks may skip without their prerequisites; report skips. The repository currently also has pre-existing whole-project TypeScript diagnostics, so record the baseline and ensure a change adds none rather than claiming an unrun clean typecheck.

## Real local services

```sh
bun scripts/dev.ts up
bun scripts/dev.ts test --case=contextvm-funding
bun scripts/dev.ts test --case=generation-preview
bun scripts/dev.ts test --case=continuation-revision
```

The funding test exercises browser → relay → ContextVM → Cashu/NWC → SQL. The generation test adds the isolated worker, real build/conformance and sandbox preview. Continuation/revision tests cover restart, explicit resume, versions and replay. Infrastructure tests alone do not prove the composed workflow.

For focused product changes, use `--case=product`, `responsive`, `progress`, `publication`, `projects`, `remix`, `chatgpt-oauth` or `chatgpt-timeout`. The [runbook](../runbooks/development-gui) gives detailed coverage. `--case=full` runs the composed gate. `--case=chatgpt-live` requires explicit live credentials and consumes subscription usage; it is not a routine docs check.

## Integration example checks

```sh
LOG_LEVEL=silent bun examples/contextvm/read-status.ts
LOG_LEVEL=silent bun examples/contextvm/check-mcp.ts
```

These read from the running CVM under the example's stable client key. They do not start generation or funding. The second starts a real stdio proxy and validates discovery/result compatibility and write denial.

## Documentation checks

```sh
bun install --cwd docs --frozen-lockfile
bun run --cwd docs build
bun run --cwd docs check:links
```

The build rejects broken internal page links; the additional check validates built routes, fragments and local assets under `/docs/`. Inspect desktop/mobile navigation, search, code/table overflow and direct deep-link reloads when changing the theme or base. See [documentation maintenance](./documentation).

## What counts as production evidence?

Local tests prove local boundaries. They do not establish five-second p95 admission, managed infrastructure failover, real Lightning routing or protected release readiness. Those are tracked in [release certification](../runbooks/release-certification) and [deferred production work](../runbooks/production-readiness-deferred).
