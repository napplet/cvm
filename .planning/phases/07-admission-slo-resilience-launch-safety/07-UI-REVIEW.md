# Phase 7 — UI Review

**Audited:** 2026-08-05  
**Baseline:** [07-UI-SPEC.md](07-UI-SPEC.md) (approved compatible-host presentation contract)  
**Screenshots:** not captured — localhost:5173 returned an unrelated Vite application titled `CAHMLS`; no compatible-host route/runtime is available in this checkout. Ports 3000 and 8080 did not respond.

---

## Audit boundary and evidence quality

The deterministic presentation projection is strong: the focused `host-presentation` suite passed all 6 tests / 142 assertions, including all 28 State Matrix rows, exact copy, identifiers, strict parsing, and a browser-evidence *schema*. This is not a rendered host. There are no production `.tsx`, `.jsx`, `.css`, or `.scss` host-surface files in this repository, and `projectHostPublicationSurface` is used only by tests and the deterministic reference set. Accordingly, the scores below assess the UI that is actually observable/implemented, not the quality of the planned interface.

Current candidate evidence also contains `security-host` records with `status: "blocked"` and `reasonCode: "CREDENTIALS_UNAVAILABLE"`; the Phase verifier explicitly reports no passed compatible-host/browser/signer observation. No browser, responsive, keyboard, dialog, focus, live-region, signer, or reconciliation pass is claimed here.

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 2/4 | Exact approved strings are projected and tested, but no real host renders them. |
| 2. Visuals | 1/4 | No compatible-host DOM/component implementation or visual evidence exists. |
| 3. Color | 1/4 | Semantic token names are contractual data only; no rendered 60/30/10 or contrast result is observed. |
| 4. Typography | 1/4 | The four-size/two-weight scale is projected, not applied to a live host. |
| 5. Spacing | 1/4 | Grid, gap, aspect ratio, scrolling, and 44px targets are unmeasured requirements. |
| 6. Experience Design | 1/4 | Critical workflow, signer, dialog, focus, and responsive interaction behavior is unobserved. |

**Overall: 7/24**

---

## Top 3 Priority Fixes

1. **BLOCKER — Integrate the projection into the exact compatible host and provide a runnable route.** The publication task cannot be visually or interactively completed from this repository. Render the schema outside the sealed iframe using the host’s primitives, with trusted host state as its sole source.
2. **BLOCKER — Run and retain candidate-bound browser evidence at desktop, tablet, and mobile widths.** The contract requires real 1280px+, 768px+, and 375px+ observations with screenshots/reports; measure grid/gap/aspect ratio, no overflow, 44px targets, contrast, and every state.
3. **BLOCKER — Exercise real host and external signer paths plus keyboard/dialog/reconciliation behavior.** Validate focus order, visible focus, modal trap/restoration, live-region throttling, reduced motion, blocked launch state, and original-operation reconciliation against the pinned host/runtime/artifact.

---

## Detailed Findings

### Pillar 1: Copywriting (2/4)

- **WARNING — Exact copy is only a projection, not visible UI.** `STATE_PRESENTATIONS` contains the approved bounded state copy, including capacity refusal, preview, publication, and launch-blocked text ([host-surface.ts](/Users/sandwich/Develop/napplet-cvm/src/publication/host-surface.ts:184)); its six focused assertions pass. No production renderer proves that the copy reaches a user without substitution, truncation, or untrusted iframe content.
- **WARNING — CTA and identifier labels remain unrendered.** The ten identifier-specific labels/copy labels are correctly mapped ([host-surface.ts](/Users/sandwich/Develop/napplet-cvm/src/publication/host-surface.ts:218)), but no host control is present to demonstrate the required visible verb-and-noun labels or accessible copy operations.

### Pillar 2: Visuals (1/4)

- **BLOCKER — There is no auditable compatible-host visual surface.** The only repository `.tsx` files are fixture applications; the production code is a TypeScript data projection. `projectHostPublicationSurface` has no production host consumer—only deterministic references/tests—so the primary preview, inspector, stepper, status markers, host-native dialogs, and sealed iframe boundary cannot be inspected.
- **BLOCKER — No valid screenshot evidence.** The responding local dev server is an unrelated `CAHMLS` app, not the compatible host. Capturing it would not establish any Phase 7 condition.

### Pillar 3: Color (1/4)

- **BLOCKER — Token allocation is declarative only.** The projection lists `var(--host-surface)`, `var(--host-surface-raised)`, `var(--host-accent)`, `var(--host-danger)`, and `60/30/10` ([host-surface.ts](/Users/sandwich/Develop/napplet-cvm/src/publication/host-surface.ts:215)); there is no host stylesheet or computed-style/browser result showing those tokens exist, meet contrast, or reserve accent/destructive color correctly.
- **BLOCKER — Color-independent status treatment is unobserved.** `textPlusShape` and `colorIndependent` are schema values, not proof of an icon/shape rendered with status text ([host-surface.ts](/Users/sandwich/Develop/napplet-cvm/src/publication/host-surface.ts:110)).

### Pillar 4: Typography (1/4)

- **BLOCKER — The prescribed type scale is not applied.** The correct four sizes/two weights and tabular-numeral intent are encoded in data ([host-surface.ts](/Users/sandwich/Develop/napplet-cvm/src/publication/host-surface.ts:215)), but no production DOM/CSS binds them to headings, labels, body copy, or identifiers.
- **BLOCKER — Long identifier readability is unverified.** Middle ellipsis is calculated ([host-surface.ts](/Users/sandwich/Develop/napplet-cvm/src/publication/host-surface.ts:179)), yet there is no browser proof of wrapping, clipping avoidance, tabular numerals, accessible full-value behavior, or labelled copy target.

### Pillar 5: Spacing (1/4)

- **BLOCKER — Responsive geometry is unmeasured.** The required scale, 32px desktop gap, 60–66/34–40 grid, 16:10 frame, mobile action width, and 44px minimum are projection fields ([host-surface.ts](/Users/sandwich/Develop/napplet-cvm/src/publication/host-surface.ts:215)), not actual layout measurements.
- **BLOCKER — Scroll/overflow behavior is unobserved.** The host/iframe scroll ownership and no-nested-horizontal-pane values are asserted by schema only ([host-surface.ts](/Users/sandwich/Develop/napplet-cvm/src/publication/host-surface.ts:215)). No desktop/tablet/mobile browser run tests clipped step labels, iframe keyboard focus, accordion behavior, or horizontal overflow.

### Pillar 6: Experience Design (1/4)

- **BLOCKER — State and action safety are projection-tested, not user-tested.** The deterministic test confirms finite states, exact labels, single next action, duplicate guards, and raw iframe presentation rejection ([host-presentation.test.ts](/Users/sandwich/Develop/napplet-cvm/tests/phase-07/host-presentation.test.ts:66)). It does not prove a user can complete preview → review → approval → signer → reconciliation in a compatible host.
- **BLOCKER — Accessibility behavior lacks browser evidence.** Landmark, focus, dialog-trap/restoration, 2px focus ring, busy-label, live-region, and reduced-motion requirements are data fields ([host-surface.ts](/Users/sandwich/Develop/napplet-cvm/src/publication/host-surface.ts:216)), with no DOM or keyboard-only test.
- **BLOCKER — Browser evidence is intentionally non-pass.** `HostBrowserEvidenceSchema` correctly permits blocked/not-observed records and returns `pass` only for all-pass real-compatible-host observations ([host-surface.ts](/Users/sandwich/Develop/napplet-cvm/src/publication/host-surface.ts:238)). Current protected `security-host` records are blocked for unavailable credentials; the verifier requires a real host/signer/browser run before promotion ([07-VERIFICATION.md](07-VERIFICATION.md)).

---

## Registry Safety

Registry audit: skipped — `components.json` is absent and the UI contract declares no third-party registry blocks.

---

## Files Audited

- [07-UI-SPEC.md](07-UI-SPEC.md)
- [07-08-PLAN.md](07-08-PLAN.md) and [07-08-SUMMARY.md](07-08-SUMMARY.md)
- [07-10-SUMMARY.md](07-10-SUMMARY.md)
- [07-VERIFICATION.md](07-VERIFICATION.md)
- [src/publication/host-surface.ts](/Users/sandwich/Develop/napplet-cvm/src/publication/host-surface.ts)
- [src/publication/contracts.ts](/Users/sandwich/Develop/napplet-cvm/src/publication/contracts.ts)
- [tests/phase-07/host-presentation.test.ts](/Users/sandwich/Develop/napplet-cvm/tests/phase-07/host-presentation.test.ts)
