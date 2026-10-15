---
phase: 07-admission-slo-resilience-launch-safety
plan: "55"
subsystem: development-workspace
status: complete
completed: 2026-10-15
requires: [07-52, 07-53, 07-56, 07-57, 07-54]
provides:
  - one-command local execution GUI lifecycle
  - complete browser journey with durable financial and artifact comparisons
  - responsive, security, persistence, and idle-liveness evidence
requirements-completed: [DEV-GUI-01, DEV-GUI-02, DEV-GUI-03, DEV-GUI-04, DEV-GUI-05, DEV-GUI-06, DEV-GUI-07, DEV-GUI-08, DEV-GUI-09, DEV-GUI-10, DEV-GUI-11, DEV-GUI-12]
production-requirements-completed: []
---

# Plan 07-55 — Running development execution workspace

The local GUI is implemented, documented, verified, and running at **http://127.0.0.1:49371** in **deterministic-fixture** mode. The external model response is the only substituted boundary. Cashu/NWC services, encrypted ContextVM, relay, PostgreSQL, metering, the isolated worker, build/verification, immutable artifacts, and Paja preview all run locally.

## Delivered

- `bun scripts/dev.ts up|status|test|down|reset` automates dependencies, Chromium, worker image, migrations, private development configuration, readiness, and scoped lifecycle. Ordinary restart preserves state; reset requires `--confirm`.
- The browser owns its disposable signing key and uses signed ContextVM for account, funding, generation, revision, and resume operations. The workspace exposes no competing HTTP generation API.
- The practical responsive workspace displays funds/holds, maximum spend, real execution timeline, usage and charge, immutable versions, compatible preview, saved-action recovery, and honest publication availability.
- The complete Chromium journey compares displayed money and action facts with SQL after ten stages. Private bounded reports/screenshots remain under `.local/development-gui-evidence/`.
- An ARM64 CI workflow runs the local suite, lifecycle, idle regression, and primary-instance readiness. YAML was validated; remote CI execution was not performed.

## Commits

- `5336df5` — launcher foundation.
- `8f1f2a8` — semantic payment/relay/migration readiness.
- `23b46f3` — responsive workspace styling and status semantics.
- `c352c57` — isolated preview access-boundary tracer.
- `117ad80` — pending envelope restored across separate processes.
- `36657e5`, `e94c790` — idle regression and browser cleanup lifecycle evidence.
- `c792c44` — final full-flow tracer, stable worker identity, browser preflight isolation, completion markers, and CI.
- README/runbook, dated acceptance matrix, and STATE/ROADMAP are updated with this summary.

## Verification

| Command / evidence | Result |
| --- | --- |
| `bun scripts/dev.ts test --case=full` | PASS: eight cases, final `{"passed":true,"case":"full"}`, exit 0 |
| `bun run tests/dev-ui/launcher.e2e.ts --case=clean-up-idempotent-down-persist-reset` | PASS: repeat startup, stable identity/URL, persistence, reset refusal/confirmation, unrelated marker retained |
| `bun run tests/dev-ui/contextvm-server-liveness.e2e.ts` | PASS: forced collection, 65 seconds without browser activity, actual HTTP health |
| Revision/adapter/session-status regression suite | PASS: 18 tests, 100 assertions |
| Revision fence, metered finalization, Phase 04/05 suites | PASS: 53 tests, 325 assertions |
| Funding regression suite | PASS: 14 tests, 55 assertions |
| Separate-process pending-envelope regression | PASS: 1 test, 6 assertions |
| Preview boundary regression | PASS: 1 test, 32 assertions; included in full suite |
| 375/768/1280 px workspace | PASS: automated layout, keyboard/focus/labels/status/reduced-motion checks; final screenshots inspected |
| Root package manifests | Byte-identical to the immutable hashes in `07-DEV-VALIDATION.md` |

The final full journey covered Cashu funding, Cashu replay, NWC funding, generation, two revisions, underfunded save, detached service restart, another Cashu top-up, and explicit resume. SQL recorded exactly **four** actions, provider operations, usage receipts, debits, completed worker results, and verified artifacts, with **20 test sats** charged. Final settled/held/available values were **15044 / 14730 / 314** and matched the GUI. Replay did not add credit; top-up did not execute the saved action.

The configured-provider branch explicitly reported `skipped_without_credentials`. The deterministic worker's actual conformance report was **5 passed, 0 failed, 5 skipped**.

## Integration fixes

1. **Stable image identity.** Timestamped build attestations changed Docker image identity across cached builds. Compose also injected per-instance project labels into the globally shared worker image. The launcher now disables local provenance/SBOM attestations and uses the constant `napplet-cvm-ui-worker` build project. Actual payment services retain per-instance projects. The launcher stores the running worker digest, rejects stale readiness, and restarts an outdated service on `up`. The final default-plus-isolated full flow passed with the same image identity.
2. **Browser probe isolation.** The real factory lost its HTTP listener after idle/collection, while a bare Bun listener remained healthy. Retaining handles and keepalive requests did not fix it and were removed. Moving startup Chromium readiness into a bounded subprocess made the factory idle and revision tests pass. This contains the [reported Bun/Playwright child-pipe finalization issue](https://github.com/microsoft/playwright/issues/42692); no production runtime guarantee is inferred. Browser test cleanup completes service/Docker operations before closing Chromium.
3. **Explicit test completion.** Standalone browser tracers emit completion markers, and the launcher requires them as well as successful process exit. Conditional provider skips remain visible.

## Honest limits

- Default output is a request-dependent deterministic counter fixture. A configured OpenAI Responses path exists but live paid calls were not exercised without credentials and price-source captures.
- Local Cashu/NWC use test money; this does not certify production Lightning routing.
- Publication says “Publication unavailable in this development setup.” No publication success is simulated.
- Conformance skips remain skips. The pinned worker is Linux ARM64; the relay requires AMD64 support/emulation.
- Unused admission holds remain reserved and are displayed separately from settled/available funds.
- Persisted worker results recover without a second build. An ambiguous build lacking a durable result fails closed and requires reconciliation.
- Remote CI, production availability/SLOs, regional recovery, protected release authorization, and publication deployment remain unverified.

## Planning handoff

Development Plans 07-52/53/56/57/54/55 are accepted. The milestone has **96/98** plans executed; Phase 7 has **56/58**. Phases remain **6/7** complete and requirements **49/54** verified. Production Plans **07-20 and 07-26**, `SESS-02`, and `OPS-01`–`OPS-04` remain deferred/pending. Production work resumes only when requested, using `docs/runbooks/production-readiness-deferred.md`.

No development acceptance work remains for this objective. The default local service is left running for review.
