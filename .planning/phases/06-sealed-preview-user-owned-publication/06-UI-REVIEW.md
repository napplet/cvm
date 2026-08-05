---
phase: 06-sealed-preview-user-owned-publication
audited: 2026-08-05
baseline: 06-UI-SPEC.md
screenshots: not-captured-host-native-contract-only
overall_score: 10/24
status: findings
---

# Phase 06 — UI Review

**Audited:** 2026-08-05  
**Baseline:** Approved `06-UI-SPEC.md`, constrained by the locked pure host-native projection boundary in `06-CONTEXT.md` D-96/D-111/D-112.  
**Screenshots:** Not captured — this phase deliberately has no DOM, route, standalone frontend, or browser surface. `.planning/ui-reviews/.gitignore` was created before this determination.

The audit does not penalize the absence of an out-of-scope CVM dashboard. It scores the shipped host-rendering contract against what the UI-SPEC requires a compatible host to receive or enforce. The deterministic host projection and status gates are sound, but it is not yet a complete renderable design contract.

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 2/4 | Safe copy exists, but action tokens and most required visible state/dialog copy are not supplied. |
| 2. Visuals | 2/4 | Artifact-first sequencing is represented, but no hierarchy, stepper, or desktop/tablet contract is encoded. |
| 3. Color | 1/4 | The projection has no semantic-token or non-colour status presentation contract. |
| 4. Typography | 1/4 | No host typography roles, weights, tabular identifiers, or label contract are exported. |
| 5. Spacing | 1/4 | No grid, spacing-scale, 44px target, aspect-ratio, or section-expansion constraints are encoded. |
| 6. Experience Design | 3/4 | Finite safe states, recovery, replay, and overflow tokens are strong; accessibility/dialog and several state distinctions are absent. |

**Overall: 10/24**

---

## Top 3 Priority Fixes

1. **BLOCKER — Make Phase 7’s compatible-host adapter consume an explicit visual-token contract.** The current projection only exports `mobileLayout: "stacked"` and overflow flags; it cannot enforce the approved 60–66/34–40 desktop grid, 32px gap, 16:10 preview, 44px targets, or host semantic colors. Add typed host-rendering requirements plus live-host evidence at desktop, tablet, and mobile widths.
2. **BLOCKER — Export exact visible labels and complete state copy, not only action identifiers.** `primaryAction` returns values such as `preview` and `publish` rather than the required labels such as **Preview verified napplet** and **Publish napplet**. Model the publish-confirmation, signer-choice, expired, incompatible, terminal-error, partial, and replay copy as safe, versioned presentation tokens.
3. **WARNING — Add an accessibility/interaction presentation schema and live-host tests.** Require landmarks, labelled iframe, stepper semantics, focus behavior, `aria-live`/alert rules, dialog lifecycle, reduced motion, and copy labels per identifier kind. The current `identifierAccessibleValue` always points to the aggregate hash and cannot name/copy the d-tag, intent, owner event, attestation, or deployment identifier.

---

## Detailed Findings

### Pillar 1: Copywriting (2/4)

- **WARNING:** The safe error map is concise and redacted (`src/publication/host-surface.ts:74-79`), and `progressLabel` provides safe recovery prose (`:89-103`). However, it exports machine action identifiers, not the UI-SPEC’s visible verb-and-noun labels: `primaryAction` returns `"preview"`, `"publish"`, and `"sign_manifest"` (`:105-113`), while the design contract requires **Preview verified napplet**, **Publish napplet**, and signer-specific labels (`06-UI-SPEC.md:201-207`).
- **WARNING:** Required empty and failure treatments are incomplete. `pre_preview` emits only “Preview the verified artifact before publication.” (`host-surface.ts:92`) rather than the required heading/body pair (`UI-SPEC.md:141`, `:208-209`). The projection has no exact host copy for expiry, incompatible runtime, confirmation, signer selection, conflict, or terminal deployment failure (`UI-SPEC.md:144-163`).
- **WARNING:** `tests/phase-06/host-surface.test.ts:25-29` checks only one safe error string and raw-field exclusion; it does not assert the copywriting contract’s complete state matrix.

### Pillar 2: Visuals (2/4)

- **WARNING:** The projection preserves a linear logical step through `flowStep` and puts the preview/review states in order (`src/publication/host-surface.ts:44-71`, `:81-87`), while capability rows retain required-first ordering (`:123-133`). This supports hierarchy, but it does not describe the specified title/status header, six-stage stepper, preview-primary frame, inspector sections, or host dialogs (`06-UI-SPEC.md:84-103`).
- **WARNING:** `mobileLayout: "stacked"` is the only responsive layout output (`host-surface.ts:64-65`, `:150-152`). The 1024px two-column proportions, tablet expanded sections, single-current mobile accordion section, and full-width mobile primary action are not represented or tested (`UI-SPEC.md:105-113`).
- **Phase 7 deferral:** A live compatible host must prove the actual visual hierarchy; no screenshot or browser capture is applicable to this pure Phase 6 contract.

### Pillar 3: Color (1/4)

- **BLOCKER (Phase 7 live-host gate):** No output maps a state or action to `var(--host-surface)`, `var(--host-surface-raised)`, `var(--host-accent)`, or `var(--host-danger)`. Consequently the approved 60/30/10 distribution, one-enabled-next-action restriction, focus ring, destructive-only danger use, and contrast requirements cannot be verified (`06-UI-SPEC.md:63-74`).
- **BLOCKER (Phase 7 live-host gate):** Capability and publication rows expose textual availability/state (`host-surface.ts:54-63`, `:125-132`) but no required host icon/shape/status-semantic contract. A host could render colour-only state, contrary to `UI-SPEC.md:74` and `:182`.

### Pillar 4: Typography (1/4)

- **BLOCKER (Phase 7 live-host gate):** The projection emits no typography role for body, label, heading, or display and no host-token binding. The exact four-size/two-weight contract therefore has no implementation-level enforcement (`06-UI-SPEC.md:48-59`).
- **WARNING:** `identifierDisplay: "middle_ellipsis"` and `identifierAccessibleValue` demonstrate the intended long-ID treatment (`host-surface.ts:67-70`, `:153-156`), but the projection neither requests tabular numerals nor provides identifier-specific accessible/copy names. It also uses the aggregate hash as the accessible value for every identifier (`:155`).

### Pillar 5: Spacing (1/4)

- **BLOCKER (Phase 7 live-host gate):** No rendered-layout requirement exposes the approved 4px scale, 32px desktop panel gap, 8px capability-row divider, 16:10 preview frame, or 44 × 44px action target floor (`06-UI-SPEC.md:30-44`, `:109`, `:167`). `inspectorScrollOwner`, `nestedHorizontalPanes`, and `descriptionWrap` are useful constraints but not sufficient measurement contracts (`host-surface.ts:64-71`, `:150-156`).
- **WARNING:** The host-surface test asserts boolean overflow tokens only (`tests/phase-06/host-surface.test.ts:55-59`), so clipped controls, stepper overflow, nested scroll regions, and one-section mobile expansion remain unverified.

### Pillar 6: Experience Design (3/4)

- **WARNING:** This is the strongest pillar. Finite state input, safe errors, required/optional capability treatment, duplicate-action disabling, changed-fact acknowledgement, quiet replay, partial reconciliation, and host-owned scrolling are all explicit (`src/publication/host-surface.ts:32-42`, `:89-157`; `tests/phase-06/host-surface.test.ts:13-65`). The related runtime projector also safely collapses untrusted messages to `ready`, `incompatible`, `expired`, or `denied` (`src/publication/public-status.ts:6-25`).
- **WARNING:** The state model does not represent the approved host-visible distinctions for preview loading versus descriptor loading, capability-review loading, signature rejection versus signature expiry, conflict, exact replay, terminal failure, confirmation open, or signer selection. Several collapse to `loading`/`error`, leaving their guard copy and permitted controls to an unspecified host (`host-surface.ts:32-42`; `06-UI-SPEC.md:134-163`).
- **WARNING:** No schema fields or tests cover landmarks, labelled iframe, `aria-current`, disabled-step explanations, focus order/restoration, dialog role/trap, live-region/alert behavior, busy labels, or reduced motion (`UI-SPEC.md:174-183`). These omissions do not justify a standalone UI in Phase 6, but they must be binding Phase 7 host-integration acceptance criteria.

---

## Registry Safety

Registry audit: no `components.json`; `06-UI-SPEC.md` lists no third-party registry blocks. No registry inspection was applicable.

## Files Audited

- `06-CONTEXT.md`, `06-UI-SPEC.md`, all `06-01` through `06-07` PLAN/SUMMARY artifacts, and `06-VERIFICATION.md`
- `src/publication/host-surface.ts`, `src/publication/public-status.ts`, `src/publication/preview-service.ts`, and `src/contextvm/adapter.ts`
- `tests/phase-06/host-surface.test.ts`, `tests/phase-06/runtime-status.test.ts`, `tests/phase-06/preview-descriptor.test.ts`, `tests/phase-06/publication-reconciliation.test.ts`, and `tests/contextvm/publication-adapter.test.ts`

## Verification Performed

- `bun test tests/phase-06/host-surface.test.ts tests/phase-06/runtime-status.test.ts tests/contextvm/publication-adapter.test.ts --timeout 10000` — 16 passed, 0 failed.
- No browser/server capture was attempted: Phase 6 intentionally provides no runnable DOM surface, and Phase 7 owns live compatible-host visual certification.
