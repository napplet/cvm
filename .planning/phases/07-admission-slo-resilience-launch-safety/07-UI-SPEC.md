---
phase: 7
slug: admission-slo-resilience-launch-safety
status: approved
shadcn_initialized: false
preset: none
created: 2026-08-05
---

# Phase 7 — UI Design Contract

> Visual and interaction contract for the compatible host's sealed-preview and publication surface. Phase 7 closes the renderable-host and live-host-certification gaps identified in Phase 6. It does not introduce a standalone CVM dashboard, editor, account surface, or visual brand.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none — consume the selected compatible host runtime's established primitives and semantic tokens |
| Preset | not applicable |
| Component library | host runtime modal, disclosure, button, status-icon, and focus primitives only; no new component-library dependency |
| Icon library | host runtime's existing icon set; icons supplement, never replace, a visible text label |
| Font | host runtime's system/application font stack |

**Source and boundary.** The root project is a Bun/TypeScript service, not a React/Next/Vite application: no production `components.json`, Tailwind configuration, or reusable UI library exists. The compatible runtime owns chrome, CSS values, signer integration, and accessibility primitives. This contract binds its adapter to explicit presentation tokens and testable layout behavior without changing that runtime's identity. The untrusted napplet stays inside its NIP-5D iframe; no host status, control, dialog, or security fact may be rendered inside or injected into that frame.

**Required adapter boundary.** Extend the Phase 6 owner-safe projection with a versioned presentation contract. It must export finite state, exact visible strings, layout-token values, semantic status, identifier kind, and accessible/copy label for every shown fact. A host must not infer labels from machine action IDs, collapse distinct states to generic `loading`/`error`, or derive authority from an iframe message, signer return, telemetry record, or provider result.

---

## Spacing Scale

Declared values (all values are multiples of 4):

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | Icon-to-label gap; status-marker gap |
| sm | 8px | Compact row gaps; capability-row divider inset; badge padding |
| md | 16px | Default card padding; control gap; mobile content inset |
| lg | 24px | Inspector/step-sheet section padding; dialog content spacing |
| xl | 32px | Desktop preview-to-inspector gap; mobile section separation |
| 2xl | 48px | Major stage separation |
| 3xl | 64px | Outer page spacing when the host supplies a full-page canvas |

Exceptions: every pointer/touch target, including copy, disclosure, close, and icon-bearing controls, is at least 44 × 44px. This is a usability floor, not an additional spacing token. Controls may have a visually compact icon but may not have a smaller hit area.

---

## Typography

Use exactly these four sizes and exactly two weights. Values inherit the host font family and foreground token.

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Body | 16px | 400 | 1.5 |
| Label | 14px | 600 | 1.5 |
| Heading | 20px | 600 | 1.2 |
| Display | 28px | 600 | 1.2 |

Use tabular numerals for hashes, timestamps, version numbers, retry hints, and identifiers. A hash, d-tag, or identifier never provides the only visual distinction: pair it with an explicit label, its current status, and an identifier-specific copy action.

---

## Color

The host provides the concrete accessible values. Apply the semantic aliases exactly; do not add a Phase 7 palette or make color the only status signal.

| Role | Value | Usage |
|------|-------|-------|
| Dominant (60%) | `var(--host-surface)` | Canvas; preview surround; primary content background |
| Secondary (30%) | `var(--host-surface-raised)` | Inspector/step sheet; summary cards; dialogs; identifier wells |
| Accent (10%) | `var(--host-accent)` | Current step; the one enabled next-action button; focus ring; confirmed deployment link |
| Destructive | `var(--host-danger)` | Explicit pre-intent cancel/abandon confirmation; terminal integrity/conflict marker only |

Accent reserved for: the single enabled next action in the linear workflow, the current step, visible keyboard focus, and a confirmed public deployment link. Inspection, back, explicit copy, signer selection, and query-only reconciliation are neutral/secondary controls. Required/optional, compatible/incompatible, verified/unverified, ready/busy, complete/partial, and blocked states require text plus a host status icon or shape in addition to color. Host tokens must meet WCAG 2.2 AA contrast: 4.5:1 for normal text, 3:1 for large text and non-text controls; the visible 2px focus indicator must achieve 3:1 against adjacent colors.

---

## Layout and Component Hierarchy

### Surface ownership

This remains a compact, owner-scoped workflow embedded by a compatible napplet runtime. It is not a service dashboard and must render only allowlisted, independently verified facts.

```
Compatible-host publication surface
├─ Flow header
│  ├─ “Verified napplet” title and compact immutable-artifact status
│  └─ Progress stepper: Artifact → Preview → Review → Publish → Sign → Status
├─ Main area
│  ├─ Sealed preview frame (primary)
│  │  ├─ Host-owned frame label and preview status
│  │  └─ NIP-5D iframe: sandbox="allow-scripts" only
│  └─ Inspection panel / mobile step sheet
│     ├─ Artifact identity and validation summary
│     ├─ Capability and runtime-compatibility review
│     ├─ Publication intent and manifest summary
│     ├─ Signer selection and signer-return status
│     └─ Deployment, manifest, attestation, and reconciliation facts
└─ Host-native dialog layer
   ├─ Publish approval
   ├─ Pre-intent cancel/abandon acknowledgement
   └─ Error, incompatibility, expiry, and reconciliation detail
```

### Responsive contract

| Viewport | Contract |
|----------|----------|
| Desktop, 1024px and wider | Two-column grid: preview 60–66%, inspector 34–40%, with a 32px gap. The inspector may be sticky only while it fully fits within the viewport. Preview uses available width and a 16:10 preferred aspect ratio; it must not clip iframe keyboard focus. |
| Tablet, 768–1023px | Preview first; inspector follows as expanded sections. The stepper remains visible and wraps labels only, never step order. Do not create side-by-side primary/secondary action groups. |
| Mobile, below 768px | One column: header/current step, preview, then an accordion-like step sheet with exactly one current section expanded. The current next action is full-width at its section bottom. The host may use a bottom sheet for signer selection or confirmation. No horizontal-scrolling stepper or side-by-side controls. |

At every width, the host owns the only outer/inspector scroll region and the iframe is the only independent scroll region. Capability rows, state cards, and identifiers must never create nested horizontal scrolling. Descriptive text wraps naturally. Identifiers use a single-line middle ellipsis only when no safe delimiter wrap is possible, and expose a labelled copy control.

---

## Host Presentation Schema

The host adapter must export the following presentation facts alongside the existing owner-safe workflow facts. Values are presentation data, not an authority channel.

| Field | Required contract |
|-------|-------------------|
| `presentationVersion` | Versioned finite contract; live-host tests reject unsupported versions rather than guessing fallback content. |
| `state` | A finite value from the State Matrix below; do not use a catch-all `loading` or `error` for distinct user decisions. |
| `action` | Existing machine action identifier plus `visibleLabel`, `accessibleName`, enabled/disabled reason, and `duplicateGuard`. Only one `isNextAction: true` action is enabled at once. |
| `layout` | `desktopGrid: "60-66/34-40"`, `desktopGapPx: 32`, `previewAspectRatio: "16:10"`, `tabletInspector: "expanded_sections"`, `mobileInspector: "single_current_section"`, and `minimumTargetPx: 44`. |
| `semanticStatus` | Finite text-plus-shape value (`verified`, `busy`, `warning`, `blocked`, `error`, `partial`, `complete`, `neutral`); it maps to host tokens but cannot be color-only. |
| `dialog` | `none`, `publish_approval`, `cancel_review`, `incompatibility_detail`, `expiry_detail`, or `reconciliation_detail`; includes exact heading/body/action copy and the applicable no-effect/cannot-cancel rule. |
| `liveAnnouncement` | `none`, `polite_once`, or `alert`; contains redacted exact status copy, never raw provider/runtime/CLI material. |
| `identifier` | `{ kind, displayValue, fullValue, accessibleName, copyLabel }`, where `kind` is the specific kind in the Identifier Contract below. The full value is exposed only to the explicit accessible name/copy operation. |
| `motion` | `reduced: "instant_or_100ms_fade"`; `standard: "150ms_opacity_transform"`; no timer, percentage, or animation may imply external-effect completion. |

The adapter accepts no display copy, CSS value, accessibility markup, or status from the iframe. Every presentation field is generated from a strict allowlist at a trusted host/coordinator boundary.

---

## Interaction and State Matrix

The flow remains artifact → preview → capability/compatibility review → explicit publish approval → trusted signer handoff → deployment/reconciliation. Future stages are unavailable until their prerequisite passes. Completed stages are inspection-only; future-step explanations remain readable even though their controls are disabled.

| State | Required visual treatment and exact copy | Permitted action / guard |
|-------|------------------------------------------|--------------------------|
| Admission accepted and preparing | Keep the submitted action's owner-safe status visible: **Starting isolated workspace…** | No second admission action. This status appears only after the durable lease binding and does not claim readiness before the probe passes. |
| Capacity unavailable | Warning card heading: **Capacity is temporarily unavailable.** Body: **No session was started and no funds were reserved. Try again after {retry hint}.** Show labelled **Admission reference**. | **Try admission again** is user initiated after the bounded hint; no automatic retry, hidden queue, new reservation, or disclosure of provider/region/tenant facts. Exact duplicate commands replay the same refusal. |
| Descriptor loading | Preview-size skeleton; inspector displays three neutral identity skeleton rows. Status: **Checking verified artifact…** | No action until descriptor identity verifies. |
| Verified artifact, no preview | Identity summary with neutral verified marker. Empty heading: **Preview not started**. Body: **Open the exact verified artifact before preparing publication.** | **Preview verified napplet**; latest durable verified artifact only. |
| Preview loading | Keep validated identity visible; preview well has a non-blocking busy marker and **Opening sealed preview…** | Disable only unsafe next-stage progress; keep inspection/back controls. |
| Preview ready | Frame plus host marker **Preview ready**. | **Review capabilities**; announce once. |
| Preview incompatible | Blocking panel: **This runtime cannot run the verified napplet.** Body: **Choose a compatible runtime to preview and publish this artifact.** Include the unavailable required capability by its safe label. | Publish remains disabled; only host runtime selection/return. Never provide a direct-authority workaround. |
| Preview expired | Neutral/amber panel: **Preview access expired.** Body: **Request a new preview for this same verified artifact. No publication was started.** | **Preview verified napplet** obtains a same-artifact descriptor only. |
| Preview denied / mismatch | Error panel: **Preview is unavailable for this artifact.** Body: **Return to the verified artifact and review its status.** | Status/diagnostics only; no bypass retry. |
| Capability review loading | Preserve identity; show capability-row skeletons and **Checking runtime compatibility…** | Cannot prepare an intent until all required results are known. |
| Capability review empty | Empty heading: **No manifest capabilities were returned.** Body: **Publication cannot continue until the verified manifest is available.** | Return to artifact status; never infer a no-capability approval. |
| Required capability missing | Blocking capability row: **Required — unavailable in this runtime.** | Review may not progress; no direct browser, network, storage, signer, or relay fallback. |
| Optional capability missing | Label: **Optional — unavailable in this runtime.** Include the verified graceful-degradation result. | Review may continue only after the degradation is displayed and remains bound to the capability digest. |
| Intent summary ready | Read-only facts and expiry; status **Ready for publication approval.** | **Publish napplet** opens publish approval; it does not create an intent before confirmation. |
| Intent invalidated | Banner: **Review changed — publication approval was cleared.** Body: **Artifact, capability, compatibility, d-tag, or policy details changed. Review the exact current details before signing.** | **Review capabilities**; old approval/signature cannot survive. |
| Publish approval dialog | Heading: **Publish this verified napplet?** Body: **You are approving deployment of the sealed artifact shown here and publication of your signed manifest. You will sign next.** Show abbreviated aggregate hash, d-tag, capability digest, and expiry. | **Approve and continue to signing** / **Return to review**. Close/Escape leaves Review with no intent. |
| Signer selecting/active | Show selected signer and **Waiting for {host/external signer}…** | Disable duplicate signer launch. **Cancel signing** may cancel only local handoff, never a persisted intent. |
| Signature rejected/invalid | Error heading: **The manifest was not accepted.** Body: **Review the manifest and sign the exact current publication intent again.** | **Review manifest**; do not reveal the rejected verification detail. |
| Signature expired/stale | Banner: **The signature is no longer valid for this publication.** Body: **The publication intent expired or changed. Start a new review and signing step.** | **Review capabilities**; never reuse the event. |
| Signature accepted | Neutral transition: **Signature verified. Preparing the original publication operation…** | No second publish control; enter observation automatically. |
| Deployment observation | Ordered non-percentage list: **Deploying sealed bytes**, **Publishing your manifest**, **Publishing CVM attestation**. Each changes only after durable observation. | No duplicate action. Notice: **Closing this surface does not cancel reconciliation.** |
| Reconciliation pending | Neutral panel: **Publication status is being reconciled.** Body: **The service is checking the original publication operation. Do not sign or publish again.** | **Reconcile publication** is query-only by original operation identity. |
| Exact replay | Quiet result: **This publication was already processed.** | **View publication details**; no celebratory animation or duplicate controls. |
| Complete success | Summary: **Napplet published.** Label deployment, owning manifest event, CVM build attestation, aggregate hash, and evidence. | **Copy publication details** and host-safe external links. |
| Partial success | Warning: **Publication is not complete.** Body: **Some results are confirmed; reconciliation will determine the remaining result.** Each absent item reads **Not yet confirmed** until authoritative observation says otherwise. | **Reconcile publication** only; no new signature or publication. |
| Conflict / replay mismatch | Error: **This publication request conflicts with an existing intent.** Body: **Review the current artifact and create a new publication only if you intend to publish a different verified artifact.** | Status/diagnostics only; no blind retry. |
| Terminal failure | Error: **Publication could not be completed.** Body: **The exact operation was recorded. Review its status before taking another action.** | **View publication status**; expose only server-authorized next actions. |
| Launch certification blocked | Operator-facing evidence summary: **Launch certification is blocked.** Body: **Required live evidence is missing, stale, failed, skipped, or not observed. Production promotion is unavailable.** | **View release evidence** only. It does not waive, rerun, or promote. Do not surface secrets, raw telemetry, provider output, or credentials. |

---

## Identifier Contract

All identifiers use middle ellipsis visually, tabular numerals where applicable, a full accessible name, and an explicit 44px-minimum copy control. The copy operation is user initiated; no value is auto-copied or revealed on hover.

| Identifier kind | Visible label | Accessible name | Copy label |
|-----------------|---------------|-----------------|------------|
| `aggregate_hash` | Aggregate hash | Full aggregate hash: {value} | Copy full aggregate hash |
| `normalized_d_tag` | d-tag | Full normalized d-tag: {value} | Copy full normalized d-tag |
| `capability_digest` | Capability digest | Full capability digest: {value} | Copy full capability digest |
| `admission_reference` | Admission reference | Full admission reference: {value} | Copy full admission reference |
| `publication_intent` | Publication intent | Full publication intent: {value} | Copy full publication intent |
| `publication_operation` | Publication operation | Full publication operation: {value} | Copy full publication operation |
| `owner_manifest_event` | Your manifest event | Full owning manifest event identifier: {value} | Copy full manifest event identifier |
| `cvm_attestation` | CVM build attestation | Full CVM build attestation identifier: {value} | Copy full CVM build attestation identifier |
| `deployment` | Deployment | Full deployment identifier: {value} | Copy full deployment identifier |
| `evidence_reference` | Evidence reference | Full evidence reference: {value} | Copy full evidence reference |

Only allowlisted owner-safe or public identifiers may appear in this table. Never render or copy prompts, revision text, generated source, chain-of-thought, worker/tool output, filesystem/storage locations, credentials, Nostr private keys, signer tokens, Cashu proofs, Lightning preimages, raw ContextVM envelopes, native receipts, CLI output, runtime messages, or provider-native errors.

---

## Accessibility, Keyboard, Dialog, and Motion

- Use one labelled host `main`, a labelled `nav`/progress indicator, one `section` for each inspection group, and a labelled iframe titled **Sealed preview of verified napplet**. Frame label, sandbox status, and preview status remain outside the iframe.
- The stepper exposes completed/current/disabled state in text; current step has `aria-current="step"`; disabled future steps have an accessible prerequisite explanation. Status facts are readable content, not disabled controls.
- Keyboard order follows visual flow: header and progress, preview host controls, inspector facts, then the current action. Focus is never sent into hidden/future controls. A 2px host-accent focus ring remains visible on every interactive element.
- Host dialogs use the runtime's modal primitive with `role="dialog"`, explicit accessible name and description, focus trap, initial focus on the least-destructive action, and focus restoration to the invoking control. Escape/close affects only a non-persisted dialog; it never cancels a persisted intent, signature result, or original publication operation.
- Buttons use visible verb-and-noun labels. Icon-only controls are prohibited unless the host primitive adds an equivalent visible tooltip and accessible name; copy controls must use the exact Identifier Contract labels.
- Use `aria-live="polite"` for one-time preview-ready, signer-return, capacity response, and reconciliation transitions. Use `role="alert"` only for blocking integrity, incompatible-runtime, capacity refusal, signature, conflict, or terminal-error states. Debounce polling and never repeatedly announce loading.
- Every busy control has an accessible busy label. Status states pair text and icon/shape. Do not rely on spinner, color, or motion alone.
- Respect `prefers-reduced-motion`: transitions are instant or at most a 100ms opacity cross-fade. Standard motion may use at most a 150ms opacity/transform transition. Do not animate external progress, effects, retries, or reconciliation completion.

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Admission refusal heading | **Capacity is temporarily unavailable.** |
| Admission refusal body | **No session was started and no funds were reserved. Try again after {retry hint}.** |
| Admission refusal CTA | **Try admission again** |
| Initial primary CTA | **Preview verified napplet** |
| Capability-review CTA | **Review capabilities** |
| Intent CTA | **Publish napplet** |
| Publish-confirmation primary action | **Approve and continue to signing** |
| Host signer CTA | **Sign with this host** |
| External signer CTA | **Use external signer** |
| Reconciliation CTA | **Reconcile publication** |
| Empty state heading | **Preview not started** |
| Empty state body | **Open the exact verified artifact before preparing publication.** |
| Error state | **Publication could not be completed. The exact operation was recorded. Review its status before taking another action.** |
| Destructive confirmation | **Cancel publication review**: **Cancel review? No publication will be created.** This applies only before intent creation; closing the surface later never cancels or deletes the operation. |

Copy does not use “retry,” “resend,” or “publish again” for ambiguous publication/payment/reconciliation states. The sole capacity-refusal CTA is explicit user-initiated re-admission after the supplied bounded hint. User-facing labels map the existing machine actions `preview`, `review_capabilities`, `sign_manifest`, `publish`, and `reconcile_publication` to the visible labels above; machine tokens are never rendered as UI copy.

---

## Live Compatible-Host Evidence Gate

Phase 7 certifies a real compatible host with browser evidence; a pure projection/unit test is insufficient. Capture immutable, content-addressed evidence for the exact host/runtime version and sealed artifact at desktop (at least 1280px), tablet (at least 768px), and mobile (at least 375px) widths.

1. Assert the 60–66/34–40 desktop grid, 32px gap, 16:10 preview, tablet expanded sections, mobile one-current-section layout, full-width mobile next action, no clipped step labels, and no nested horizontal scrolling.
2. Assert all action, copy, disclosure, and dialog-close targets are at least 44 × 44px; check visible labels and exact copy for every State Matrix row, including capacity refusal, incompatibility, expiry, publish approval, signer selection, partial/replay/conflict/terminal states, and blocked launch certification.
3. Assert the adapter emits the Host Presentation Schema rather than raw action IDs, a generic state, or a shared aggregate-hash accessibility value. Test every Identifier Contract kind separately.
4. Assert semantic host token binding and text-plus-icon/shape status treatment; verify contrast and visible focus with keyboard-only navigation.
5. Assert landmarks, iframe title, `aria-current`, disabled-step reason, focus order, dialog name/description/trap/restoration, live-region rate limiting, busy labels, color-independent state, and reduced-motion behavior.
6. Run the evidence path through host preview, trusted host signer, external signer when supported, original-operation reconciliation, and the launch-certification blocked state. Missing credentials must produce explicit `blocked`/`not_observed` evidence and must block the claim; never fabricate a pass.

---

## UI Considerations

Applicable state considerations resolved: 20 covered, 0 backstop, 0 unresolved.

| Category | Element(s) | Status | Resolution / Reason |
|----------|------------|--------|---------------------|
| empty | sealed preview well; capability review | ✅ covered | Preview-before-start and absent-manifest states use the documented heading/body copy and block publication. |
| loading | admission; descriptor; preview; compatibility; signer; deployment observation | ✅ covered | Each in-flight state has distinct redacted status copy, visible verified identity where applicable, and no duplicate progression. |
| error | capacity; descriptor/preview; signature; publication; launch certification | ✅ covered | State Matrix supplies exact safe copy, query-only or explicit next action, and never exposes raw provider/runtime material. |
| populated | preview frame; artifact facts; capability rows; publication result | ✅ covered | Normal content presents the exact verified artifact, required-first capability rows, and labelled allowlisted outcome facts. |
| partial | optional capability degradation; multi-effect publication | ✅ covered | Optional degradation is named; independently observed effects remain partial and reconcile only by original operation. |
| overflow | inspector; stepper; capability rows; identifiers | ✅ covered | Host owns outer scrolling; no nested horizontal panes; descriptions wrap; identifiers ellipsize with full accessible/copy values. |
| zero-one-many | capability and publication-evidence collections | ✅ covered | Zero blocks with explicit manifest copy; one retains full row layout; many retain required-first labelled rows and per-effect state. |
| long-text | capability purpose; state guidance; d-tag; hashes; IDs; action labels | ✅ covered | Guidance/purpose wraps; controls preserve 44px targets; identifiers use labelled middle ellipsis and explicit full-value copy. |

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| Compatible host runtime design system | Existing host primitives only | No registry block imported by this phase |
| shadcn official | none | Not initialized; not applicable |
| Third-party registries | none | Not applicable |

---

## Acceptance Criteria

1. A versioned host presentation schema exports exact labels, distinct state/dialog copy, layout values, status semantics, motion rules, and identifier-specific accessibility/copy fields; no host guesses from machine action IDs or raw untrusted data.
2. Live compatible-host evidence proves the desktop, tablet, and mobile rendering contract, including the 60–66/34–40 desktop grid, 32px gap, 16:10 preview, one-current-section mobile step sheet, and 44px target floor.
3. The host renders every State Matrix treatment exactly, including immediate retryable capacity refusal that makes clear no session or funds were reserved, and never suggests a durable queue or an automatic retry.
4. The presentation uses host semantic tokens with the stated 60/30/10 allocation, one next action, destructive-only danger, contrast, and text-plus-icon/shape status semantics.
5. The host uses exactly four typography sizes and two weights, preserves readable hierarchy, and handles long text/identifiers without clipping, horizontal overflow, or ambiguous accessibility names.
6. Each aggregate hash, d-tag, digest, admission reference, intent/operation, owner event, attestation, deployment, and evidence reference has the exact Identifier Contract label, accessible name, and copy action; no sensitive/internal data becomes visual, spoken, copied, or error content.
7. Keyboard, focus, landmark, iframe-label, stepper, dialog, live-region, busy, color-independent status, and reduced-motion behavior meet the Accessibility, Keyboard, Dialog, and Motion contract.
8. Browser evidence covers host preview and compatible signer/reconciliation paths; absent live credentials result in explicit blocked evidence and prevent the v1.0 certification/promotion claim.

---

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS
- [x] Dimension 2 Visuals: PASS
- [x] Dimension 3 Color: PASS
- [x] Dimension 4 Typography: PASS
- [x] Dimension 5 Spacing: PASS
- [x] Dimension 6 Registry Safety: PASS

**Approval:** approved 2026-08-05 — 6/6 dimensions passed with no recommendations.
