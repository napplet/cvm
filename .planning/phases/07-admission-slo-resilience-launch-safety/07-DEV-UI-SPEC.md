# Phase 07 Development GUI — UI Addendum

This addendum narrows the approved Phase 07 UI contract to the local development workspace. It inherits the tokens, typography, responsive breakpoints, focus treatment, motion preferences, and accessibility rules in `07-UI-SPEC.md`. Those base rules remain authoritative.

## Workspace Contract

The browser presents one task-focused workspace in this order:

1. **Connection header** — relay state, disposable user identity, active account, model mode (`Deterministic` or `Provider: <name>`), and an explicit reconnect action.
2. **Funds and limits** — persisted balance, pending settlement state, funding rail controls for local Cashu and NWC, funding receipt/result, action ceiling, estimated reserve, and the maximum the user approved.
3. **Create or revise** — bounded idea input with remaining characters, maximum-spend input, primary `Generate napplet` action, and revision input associated with the selected version.
4. **Session timeline** — accepted, reserved, model, source stored, worker ready, build, verification, preview, pause, resume, revision, publication, and failure events. Each entry shows server time, status, exact charged usage when applicable, remaining action budget, and an actionable error.
5. **Versions and preview** — version list with immutable artifact identifiers, verification state, selected-version detail, and the official compatible sandbox host. Only a server-projected, verified preview descriptor may select preview bytes.
6. **Continuation and publication** — a paused session shows the actual funding shortfall, existing checkpoint, expiry, fund control, and signed `Resume` action. Publication shows available actions only when a configured adapter exists; otherwise it reads `Publication unavailable in this development setup` and links to the verified local artifact details.

## Responsive Layout

- At and above 1024 px, use the inherited 12-column grid: connection spans 12; funds/create spans 4; timeline/versions/preview spans 8. Keep preview visible while the user inspects a selected version when viewport height permits.
- From 768 through 1023 px, use a single reading column with funds before create, then timeline, versions, preview, and continuation/publication.
- Below 768 px, use one column, full-width controls, 44 px minimum targets, no horizontal page scrolling, and a compact non-sticky connection summary. Preview keeps a bounded aspect ratio and can open in the same page region without obscuring status or errors.
- Preserve the base 4 px spacing scale, existing semantic colors, 16 px body text, 14 px supporting text, 20 px section headings, 28 px page heading, and weights 400/600. Do not add a second palette or font family.

## Interaction and State

| Control or region | Enabled when | Busy/state behavior | Error behavior |
|---|---|---|---|
| Connect/reconnect | relay bootstrap configuration is valid | announces connecting then connected pubkey | retain identity locally and show retryable relay error |
| Cashu/NWC fund | connected and positive amount is within exposed local ceiling | one request owns one immutable payment-tag set; show pending settlement | show rail-specific failure without optimistic balance |
| Generate | connected, bounded idea valid, and maximum is at least the displayed active-profile ceiling; insufficient persisted balance does not disable the control | disable duplicate submit for the same idempotency key; sufficient funds follow signed funded admission/start, while low balance sends signed `start_session` mode `pre_admission` and shows the explicitly saved pending action from durable server projection | focus the first invalid field; treat a confirmed saved pending action as a paused success with Fund and Resume controls, and show only durable admission/generation failures as errors |
| Revise | a verified version is selected and revision text is valid | keep the selected source version visible until the next version verifies | retain prior verified version and show revision error |
| Resume | session is paused and a real, unexpired checkpoint exists | issue a signed ContextVM resume and show restore stages | keep pause controls available with precise recovery text |
| Preview version | version is verified and descriptor is current | load the official compatible host with expiring bytes | replace the frame with descriptor/host error and retry action |
| Publish | a publication adapter reports available for this session/version | show dry-run/real state from the adapter | never imply publication succeeded without adapter evidence |

Every asynchronous action has a visible text status in addition to color or animation. Live status uses a polite region; terminal failures use an assertive alert only once. Focus returns to the affected control after a failed action and moves to the new result heading after a successful user-initiated action.

## Data Ownership and Trust Boundaries

- The browser creates and retains the disposable user's Nostr private key. It sends signed/encrypted ContextVM messages with the official SDK and never serializes the private key into bootstrap data, logs, URLs, database rows, HTML attributes, error reports, or screenshots.
- Server service keys, database credentials, model-provider secrets, payment service credentials, and preview signing material remain server-side.
- HTTP serves static UI assets, non-secret bootstrap configuration, health/readiness, expiring preview bytes, and an explicitly local dev faucet when required. Generate, revise, resume, account, balance, usage, session, and funding commands travel through ContextVM over the real relay.
- UI account, balance, session, timeline, usage, versions, checkpoint, and publication state comes from signed ContextVM responses backed by durable server state. The browser does not invent optimistic financial or completion state.
- The server validates preview ownership and expiry before returning immutable bytes. The host loads those bytes inside the pinned official compatible sandbox runtime. Generated content never shares an origin with the workspace and receives no user key, cookies, storage, relay object, database access, provider secrets, or service credentials.
- The napplet iframe policy follows the base spec: `sandbox="allow-scripts"` without `allow-same-origin`; the parent host validates message origin/source, schema, declared capabilities, and request/response correlation before capability dispatch.

## Required Browser Assertions

- Keyboard-only operation reaches every action in reading order with visible focus; all fields have programmatic labels and errors; status changes are announced once.
- At 375 px, 768 px, and 1280 px there is no page-level horizontal overflow, hidden primary action, clipped error, or inaccessible continuation control.
- Displayed balance, charges, remaining budget, session state, checkpoint, and version identifiers equal the persisted SQL/checkpoint/artifact evidence read after the same browser action.
- Deterministic and configured-provider runs are visibly distinguishable, while both create source, run the worker/build/conformance pipeline, and produce a verified sandbox preview.
- Duplicate browser submissions and relay redelivery do not duplicate credits, reservations, charges, versions, resumes, or publication effects.
