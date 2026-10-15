# Phase 07 Development GUI — Validation Contract

This contract defines the executable evidence for the development GUI. The evidence is local-development evidence only. It does not complete or waive production requirements, Phase 07 plans 20/26, operator approval, registry promotion, multi-region operation, or production drills.

## Immutable Inputs

- Root `package.json` SHA-256: `cbcc433278d32391b075576ebd847ae30039f1d86ad229a149f5566856989f23`
- Root `bun.lock` SHA-256: `8916ee4ec92924ae9e09bc4f315fd6656033812696e35a1b7785161d872c5ac3`
- ContextVM SDK: installed `@contextvm/sdk@0.13.10`, using `NostrClientTransport` in the browser and `NostrServerTransport` plus `ContextVmSdkBridge` on the server.
- Browser/host test package: standalone `tests/dev-ui/package.json` and lockfile pin Playwright `1.62.1` with registry integrity `sha512-0M+L3LAD8/nm554LOla9Ayx0j0tmFZ0FBcoQ7F1VuVHpM/XpiC8RcDzBQB8W5+hA8L22THxELzeF+2WcUzvcLg==`; root manifests remain byte-identical.
- Compatible host: exact reviewed official napplet source revision/package provenance for `@kehto/paja@0.19.0`, with recorded integrity hash. An arbitrary sibling checkout is not a launch dependency.
- Development toolchain: separate pinned local image/adapter with actual CLI/build/verify/Chromium conformance/dry-run commands and integrity evidence. It preserves the production sealed-runner guards but does not require deferred production registry promotion/operator approval.

## Required Commands

The final launcher owns these stable commands:

| Command | Required result |
|---|---|
| `bun scripts/dev.ts up` | Idempotently starts prerequisites, migrations, relay, ContextVM server, GUI, local rails, development worker/host, and prints the URL plus readiness. |
| `bun scripts/dev.ts status` | Reports each dependency, schema, relay identity, browser/host/toolchain preflight, provider mode, and ready/not-ready reason without secrets. |
| `bun scripts/dev.ts test --case=contextvm-funding` | Runs Plan 52 real Chromium -> relay -> ContextVM -> Cashu/NWC -> Postgres cases. |
| `bun scripts/dev.ts test --case=generation-preview` | Runs Plan 53 actual source -> metered model -> isolated worker -> build/verify/conformance -> compatible preview cases. |
| `bun scripts/dev.ts test --case=continuation-revision` | Runs Plan 54 pause/top-up/restart/explicit-resume and revision/version duplicate/recovery cases. |
| `bun scripts/dev.ts test --case=full` | Runs the complete browser flow plus security, ownership, responsive, keyboard, and displayed-versus-persisted assertions. |
| `bun scripts/dev.ts down` | Stops application processes/containers and preserves durable local data. |
| `bun scripts/dev.ts reset --confirm` | Stops the stack and removes only named development volumes/state after explicit confirmation. |

Until Plan 55 supplies the stable wrapper, Plans 52–54 may run their named test files directly, but each plan must be self-contained and start its own documented prerequisites.

## Requirement-to-Evidence Matrix

| Requirement | Plan | Automated evidence | Real boundaries required |
|---|---:|---|---|
| DEV-GUI-01 identity/connectivity | 52, 55 | `contextvm-funding` and `full` | Chromium, browser-owned key, real relay, official encrypted SDK, bridge event identity |
| DEV-GUI-02 Cashu/NWC funding | 52, 54 | both-rails replay/restart; pause funding | actual local Cashu and NWC services, adapter, SQL ledger; displayed balance equals SQL |
| DEV-GUI-03 bounded idea/max/ceiling | 52, 53 | generation validation and reserve gates | signed ContextVM command, configured price card, action maximum |
| DEV-GUI-04 progress/usage/spend/budget | 53, 54, 55 | generation and continuity browser assertions | durable session/usage/ledger projections; displayed values equal SQL/evidence |
| DEV-GUI-05 verified sandbox preview | 53, 55 | compatible-preview and full | generated source, local isolated worker, actual CLI/build/verify/Chromium, official paja host, expiring bytes |
| DEV-GUI-06 revisions/versions | 54, 55 | revisions-duplicates-restarts and full | metered proposal, verified immutable artifacts, durable ordered versions |
| DEV-GUI-07 pause/top-up/resume | 54, 55 | pause-fund-restart-explicit-resume | real pending-action checkpoint, local rail, service restart, separate signed resume |
| DEV-GUI-08 publication honesty | 53–55 | unavailable/configured adapter assertions | durable adapter availability and evidence; no inferred success |
| DEV-GUI-09 one-command lifecycle | 52, 55 | launcher lifecycle cases | migrations/readiness/credentials/rails/relay/worker/host; persist and reset semantics |
| DEV-GUI-10 full browser E2E | 52–55 | `--case=full` | GUI, ContextVM, relay, payment rail, SQL, model, worker, preview in one trace |
| DEV-GUI-11 model modes | 53, 55 | deterministic real-boundary case; conditional configured-provider case | deterministic substitutes only model; provider returns genuine usage/proposal |
| DEV-GUI-12 accessibility/security | 52–55 | security-accessibility browser suite | widths 375/768/1280, keyboard/focus/status, owner/expiry/iframe/key/secret negatives |

Related production IDs `SESS-02` and `OPS-01` through `OPS-04` appear in plan frontmatter for traceability. A passing development matrix records evidence only; their production status stays pending until their existing production plans and drills complete.

## Mandatory Full-Flow Assertions

1. Start from reset state and create a disposable browser identity; prove only its public key reaches server persistence/logs.
2. Fund beyond the exposed action reserve through actual Cashu and NWC local rails; replay Cashu and restart during NWC settlement; prove one credit per payment identity.
3. Submit a bounded idea and user maximum through encrypted ContextVM. Prove the one metered model operation produces the content-addressed source proposal given to the worker.
4. In deterministic mode, prove the source changes with the request and all non-model boundaries are real. With provider credentials, prove actual provider output, usage, price card, charge, and artifact; otherwise emit an explicit conditional skip.
5. Prove the development-only pinned worker runs the required CLI/build/verify/real-Chromium conformance/dry-run commands and the official compatible host renders the verified immutable bytes.
6. Compare displayed model mode, timeline, usage, exact charge, remaining action budget, account balance, session state, version, artifact digest, verification state, and checkpoint with SQL/checkpoint/artifact evidence.
7. Create an insufficient-funds action. Prove a truthful pending-action checkpoint exists before any provider/worker call. Fund, restart, remain paused, click signed Resume, and prove the original action completes once.
8. Create two revisions and select all versions. Inject duplicate delivery and restart before/after provider result, worker result, charge, version commit, preview selection, and resume. Prove no duplicate effect.
9. Deny forged identity, cross-owner/expired/altered/unverified preview, invalid iframe message/capability, checkpoint tamper, wrong resume version/policy/ceiling, and generated-code access to keys/secrets/network/storage.
10. Prove publication controls are absent/disabled with the required unavailable copy when no adapter is configured; with an adapter, show only its evidenced state.

## UI and Accessibility Assertions

- At 375 px, 768 px, and 1280 px, no page-level horizontal overflow, clipped error, hidden primary action, or unreachable resume/version control exists.
- Keyboard order follows connection, funds, create/revise, timeline, versions/preview, continuation/publication. Focus is visible and returns/moves according to `07-DEV-UI-SPEC.md`.
- Every input has an accessible name and linked error; busy/status/terminal changes are announced once; color is never the only status cue; reduced-motion preferences are honored.
- The iframe has `allow-scripts` and lacks same-origin privilege. Generated content uses a distinct origin and cannot access the user key, service secrets, cookies, host storage, relay client, database, payment credentials, or provider credentials.

## Multi-Source Coverage Audit

### GOAL

| Source item | Coverage | Status |
|---|---|---|
| A working local development GUI exercises the complete user journey through real service boundaries | 52 proves wire/funding; 53 generation/worker/preview; 54 continuity/revision; 55 lifecycle/full browser verification | COVERED |
| Service remains ContextVM-public and transport-neutral with no HTTP generation API | 52/53 network assertions and route allowlists | COVERED |
| Development setup is repeatable, inspectable, and honest about local versus production claims | 55 launcher/runbook/report; production deferral in all plans | COVERED |

### REQ

| Requirement item | Coverage | Status |
|---|---|---|
| SESS-02 continuity behavior | 54 real local pause/checkpoint/resume evidence; production completion explicitly excluded | COVERED AS DEVELOPMENT EVIDENCE |
| OPS-01 availability/latency evidence | 53 local worker readiness + 55 measurements; no production SLO claim | COVERED AS DEVELOPMENT EVIDENCE |
| OPS-02 reconciliation/recovery | 52 funding reconciler + 54 duplicate/restart recovery + 55 suite | COVERED AS DEVELOPMENT EVIDENCE |
| OPS-03 stop/reset/deletion semantics | 55 launcher persist/reset assertions; no production lifecycle claim | COVERED AS DEVELOPMENT EVIDENCE |
| OPS-04 monitoring/runbook | 53 truthful timeline + 55 status/runbook/evidence; no production ops claim | COVERED AS DEVELOPMENT EVIDENCE |

### RESEARCH

| Research constraint/finding | Coverage | Status |
|---|---|---|
| Use official browser SDK and real relay; direct adapter/BFF surrogate is invalid | 52 | COVERED |
| Bridge lacks lifecycle/notification/multi-meta support | 52 | COVERED |
| Real Cashu/NWC/SQL path; NWC settlement requires bounded restart-aware observer | 52 | COVERED |
| Current 1,024-sat funding is below 3,750-sat reserve; expose ceiling and automate enough funds | 52 | COVERED |
| Model gateway currently lacks prompt/source result and accepts fixture provider only | 53 source proposal bridge, provider/price-card generalization | COVERED |
| Deterministic mode substitutes only external model; real provider path must exist | 53 and 55 | COVERED |
| Actual CLI/build/verify/conformance/dry-run and source provenance are required | 53 | COVERED |
| Published conformance package is not the full host; official paja 0.19.0 host is required | 53 | COVERED |
| Chromium/system dependencies and Apple Silicon/x86 toolchain mismatch require an explicit supported execution path | 53 readiness and platform tests | COVERED |
| Pre-worker insufficient-funds pause currently has no checkpoint | 54 pending-action checkpoint and explicit resume | COVERED |
| Root package manifests must remain immutable | 52 and 55 hash gates; isolated browser package | COVERED |
| Production plans 20/26 remain deferred and are not a development blocker | all plans and this contract | EXCLUDED FROM DEVELOPMENT COMPLETION, NOT A GAP |

### CONTEXT

| Decision group | Coverage | Status |
|---|---|---|
| D-114–D-117 identity/admission/dedupe invariants applicable to local development | 52, 54, 55; production scale claims excluded | COVERED |
| D-118–D-121 worker/readiness/recovery invariants applicable to local development | 53–55; production pool/region claims excluded | COVERED |
| D-122–D-125 durable checkpoint/resume semantics | 54–55 | COVERED |
| D-126–D-140 production rollout, monitoring, regional, restore, lifecycle, and release evidence | Existing production plans, especially deferred 20/26 | SCOPED TO PRODUCTION; NOT A DEVELOPMENT GAP |
| D-141–D-144 SDK wire, custody, HTTP boundary, real funding/ceiling | 52 | COVERED |
| D-145–D-147 generation/provider/worker/official host | 53 | COVERED |
| D-148–D-150 real continuation, durable UI/recovery, publication honesty | 54 with 53/55 verification | COVERED |
| D-151–D-155 immutable root, UI, launcher, production deferral, full real browser suite | 52 isolated tests; 53 host; 55 launcher/UI/suite; all plan deferral clauses | COVERED |

## Direct User Deliverable Audit

| Deliverable | Plan(s) |
|---|---|
| Disposable identity/connectivity and actual account | 52 |
| Local Cashu/NWC funding and persisted balance | 52 |
| Idea, maximum, start, ceiling/reserve | 52–53 |
| Progress, stages, errors, usage, spend, remaining budget | 53–55 |
| Real sandbox preview | 53 |
| Revisions and version history | 54 |
| Insufficient funds, top-up, explicit resume | 54 |
| Honest publication availability | 53–55 |
| One command, readiness, migrations, stop/reset/persist | 55 |
| Full browser/relay/SQL/worker/preview, duplicate, and restart tests | 52–55 |
| Responsive accessible practical workspace | UI addendum, 52–55 |
| README/runbook/GSD state update, final URL/commands/flows/limitations, leave running | 55 |

All source items are covered or explicitly scoped to deferred production work. No production requirement is declared complete by these development plans.
