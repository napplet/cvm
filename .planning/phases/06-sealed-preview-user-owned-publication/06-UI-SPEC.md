---
phase: 6
slug: sealed-preview-user-owned-publication
status: approved
shadcn_initialized: false
preset: none
created: 2026-08-05
---

# Phase 6 — UI Design Contract

> Visual and interaction contract for the host-native sealed-preview and user-owned-publication flow. The compatible napplet runtime owns the chrome, tokens, signer integration, and accessibility primitives; this phase must not introduce a standalone CVM dashboard or competing visual brand.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none — consume the compatible host runtime's established primitives and semantic tokens |
| Preset | not applicable |
| Component library | host runtime primitives only; no new component-library dependency |
| Icon library | host runtime's existing icon set; icons are supplementary and every action keeps a visible text label |
| Font | host runtime's system/application font stack |

**Source and boundary.** The root project is a Bun/TypeScript service, not a standalone React/Next/Vite UI, and has no `components.json`, Tailwind configuration, or reusable production UI library. This contract deliberately specifies token roles rather than hex values: inherit the selected compatible runtime's accessible token values without altering its visual identity. The previewed napplet remains in its own NIP-5D iframe; host review controls must never be rendered inside or injected into that iframe.

---

## Spacing Scale

Declared values (all values are multiples of 4):

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | Icon-to-label gaps, status-dot spacing |
| sm | 8px | Compact row gaps, badge padding |
| md | 16px | Default card padding, form/control gaps |
| lg | 24px | Panel padding and distinct review sections |
| xl | 32px | Desktop preview-to-inspector gap and mobile section separation |
| 2xl | 48px | Major flow-stage separation |
| 3xl | 64px | Host-page outer spacing when the runtime provides a full-page canvas |

Exceptions: all pointer/touch targets are at least 44 × 44px; this is a usability floor, not an additional spacing token. Do not use tighter hit areas for icon-only controls.

---

## Typography

Use exactly these four sizes and exactly two weights. All values inherit the host font family and host text-color tokens.

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Body | 16px | 400 | 1.5 |
| Label | 14px | 600 | 1.5 |
| Heading | 20px | 600 | 1.2 |
| Display | 28px | 600 | 1.2 |

Use tabular numerals for short hashes, timestamps, version numbers, and operation identifiers. Never make a hash, d-tag, or identifier the only distinguishing visual signal; pair it with its explicit label and status.

---

## Color

The host runtime supplies the concrete accessible values. Apply its semantic aliases exactly as below; do not add a phase-specific palette or use color as the only status indicator.

| Role | Value | Usage |
|------|-------|-------|
| Dominant (60%) | `var(--host-surface)` | Canvas, preview frame surround, primary content background |
| Secondary (30%) | `var(--host-surface-raised)` | Inspector/step sheet, summary cards, dialog surfaces, code/identifier wells |
| Accent (10%) | `var(--host-accent)` | Current-step indicator; one enabled next-action button; visible keyboard focus ring; link to a completed public deployment |
| Destructive | `var(--host-danger)` | Explicit cancel/abandon confirmation and terminal integrity/conflict markers only |

Accent reserved for: the single next action in the linear flow, the current step, keyboard focus, and a confirmed deployment link. Secondary/neutral buttons are used for inspection, back, copy, retry-safe refresh, and signer selection. Required/optional capability state uses a named text label plus host semantic status icon; it must not rely on yellow/red/green alone. Host token values must meet WCAG 2.2 AA contrast: 4.5:1 for normal text, 3:1 for large text and non-text controls.

---

## Layout and Component Hierarchy

### Surface ownership

This is a compact workflow embedded by a compatible napplet runtime. It receives an owner-scoped descriptor and displays only its allowlisted fields. It is not an HTTP application, account dashboard, editor, or publication history page.

```
Host publication surface
├─ Flow header
│  ├─ “Verified napplet” title and compact immutable-artifact status
│  └─ Linear stepper: Artifact → Preview → Review → Publish → Sign → Status
├─ Main area
│  ├─ Sealed preview frame (primary)
│  │  ├─ Host-owned frame label/status
│  │  └─ NIP-5D iframe: sandbox="allow-scripts" only
│  └─ Inspection panel / mobile step sheet
│     ├─ Artifact identity and validation summary
│     ├─ Capability and runtime-compatibility review
│     ├─ Publication intent and manifest summary
│     ├─ Signer chooser and signer return status
│     └─ Deployment, manifest, attestation, and reconciliation facts
└─ Host-native modal/dialog layer
   ├─ Explicit publish approval
   ├─ Cancel/abandon acknowledgement
   └─ Error, incompatibility, expiry, and reconciliation detail
```

### Desktop and mobile

| Viewport | Contract |
|----------|----------|
| Desktop, 1024px and wider | Use a two-column grid: preview at 60–66% width, inspector at 34–40%; 32px gap. Keep the inspector sticky only while it fits within the host viewport. The preview frame uses the available width, 16:10 preferred aspect ratio, and never clips the iframe's own keyboard focus. |
| Tablet, 768–1023px | Keep preview first. Render the inspector below it as expanded sections; the stepper remains visible and wraps only its labels, never the step order. |
| Mobile, below 768px | One column: header and current step, preview, then an accordion-like step sheet with exactly one current section expanded. The next action is full width at the bottom of the current section. The host may use a bottom sheet for signer selection and confirmations. Do not use a horizontal scrolling stepper or side-by-side controls. |

At every width, identifiers wrap only at safe delimiter opportunities; otherwise show a single-line middle ellipsis (`abcd…wxyz`) and provide a labelled Copy control that copies the complete value. Long capability purposes and error guidance wrap naturally; they are never clipped behind a gradient or tooltip-only disclosure.

### Flow navigation

The stepper is a progress indicator, not free-form navigation. Completed stages are selectable for inspection only; the current stage is selected; future stages are disabled and expose the reason in text. The user may return to Artifact, Preview, or Review before publication intent creation. Any change that affects artifact, manifest, d-tag, capability digest, selected-runtime compatibility, or policy resets the flow to Review, invalidates prior intent/signature, and announces the reset. A status card always names the exact required next action.

---

## Interaction Contract

| Stage | Host UI and permitted action | Required guard |
|-------|------------------------------|----------------|
| 1. Verified artifact | Show aggregate-hash identity, artifact version, sealed object checksum/generation, validation result, compatibility identity, and evidence reference. Primary action: **Preview verified napplet**. | Enable only for the latest durable `verified` artifact whose descriptor identity matches every displayed identity field. Failed, incomplete, stale, superseded, or mismatched artifacts offer diagnostics/status only. |
| 2. Sealed preview | Render the descriptor-bound artifact in a host-created NIP-5D iframe. Show a concise host status (`Loading preview`, `Preview ready`, `Incompatible`, `Preview expired`, or `Preview unavailable`) outside the iframe. Primary action after ready: **Review capabilities**. | Iframe is exactly `sandbox="allow-scripts"`; never add `allow-same-origin`. Untrusted runtime messages can update only the safe preview status display. They cannot enable publish, alter identity, create intent, or mutate billing/session/artifact state. |
| 3. Review | List required capabilities first, then optional capabilities, each with capability name, plain-language purpose, consent implication, and this runtime's compatibility result. Required unavailable capabilities block progression; optional unavailable capabilities state the verified graceful-degradation behavior. Primary action when allowed: **Prepare publication**. | No direct browser/network/storage/signer/relay fallback is offered or implied. The review footer shows the exact capability-set digest; continuing records approval of that digest only. |
| 4. Explicit publish approval | Show a compact, read-only publication intent summary: owner public-key fingerprint, session, aggregate hash, normalized d-tag, capability digest, compatible runtime, and expiry. **Publish napplet** opens a host-native confirmation dialog; confirming creates the persisted intent. | Confirmation is mandatory and states that it approves publication of this exact reviewed artifact. Close/Escape leaves the flow at Review with no intent. Changed/expired facts invalidate the dialog and return to Review. |
| 5. Sign | After intent creation, show the exact owning-manifest summary and signer choices supported by the host: **Sign with this host** and/or **Use external signer**. The selected signer presents the full canonical event using its trusted UI. | Never render a key field, secret, signer token, delegated key, or private-key import control. CVM receives only the completed signed event. A returned event must be independently verified before status can advance. |
| 6. Deployment and reconciliation | On accepted signature, show an in-flight status while the original persisted operation is observed. Terminal result displays deployment, user manifest, CVM attestation, aggregate hash, and evidence references. | Deployment uses only previously previewed sealed bytes. Ambiguous effects enter reconciliation and query the original operation; no retry button may create a new operation, signature request, deployment, manifest, or attestation. |

---

## State Matrix

Every state is host-rendered outside the untrusted iframe. State changes use a concise visible status plus an `aria-live` announcement; do not announce raw provider errors or status polling noise.

| State | Visual treatment and copy | Available action / constraint |
|-------|---------------------------|-------------------------------|
| Descriptor loading | Preview-sized skeleton in the primary area; inspector identity rows use 3 neutral skeleton lines. Status: **Checking verified artifact…** | No action until descriptor identity is verified. |
| Verified artifact, no preview yet | Identity summary with neutral verified badge. Empty preview well heading: **Preview not started**. Body: **Open the exact verified artifact before preparing publication.** | **Preview verified napplet**. This is the normal pre-preview empty state. |
| Preview loading | Keep validated identity visible; preview well contains a non-blocking spinner and **Opening sealed preview…** | Disable only the next-stage action; retain the back/inspection controls. |
| Preview ready | Preview frame plus host badge **Preview ready**; announce once. | **Review capabilities**. |
| Preview incompatible | Host warning panel: **This runtime cannot run the verified napplet.** Body names the unavailable required capability and says **Choose a compatible runtime to preview and publish this artifact.** | Publish is disabled. The only action is host-provided compatible-runtime selection/return; never offer a direct-authority workaround. |
| Optional capability unavailable | Capability row is labelled **Optional — unavailable in this runtime** and includes the explicit graceful-degradation behavior. | Review can continue only after the degradation result is shown and remains bound to the capability digest. |
| Preview grant expired | Neutral/amber host panel: **Preview access expired.** Body: **Request a new preview for this same verified artifact. No publication was started.** | **Preview verified napplet** requests a fresh, same-artifact descriptor; it cannot substitute bytes. |
| Preview denied or descriptor mismatch | Error panel: **Preview is unavailable for this artifact.** Body: **Return to the verified artifact and review its status.** | No retry that bypasses validation; show diagnostics/status only. |
| Capability review loading | Preserve previously verified identity and show capability-row skeletons. Status: **Checking runtime compatibility…** | Cannot prepare intent before all required results are known. |
| Capability review empty | Empty-state heading: **No manifest capabilities were returned.** Body: **Publication cannot continue until the verified manifest is available.** | Return to artifact status; no inferred “no capabilities” approval. |
| Intent summary ready | Read-only facts plus expiry. Status: **Ready for publication approval.** | **Publish napplet** opens the explicit confirmation dialog. |
| Intent invalidated | Banner: **Review changed — publication approval was cleared.** Body: **Artifact, capability, compatibility, d-tag, or policy details changed. Review the exact current details before signing.** | **Review capabilities**; never retain a prior approval/signature. |
| Publish confirmation | Host-native modal heading: **Publish this verified napplet?** Body: **You are approving deployment of the sealed artifact shown here and publication of your signed manifest. You will sign next.** Secondary facts: abbreviated hash, d-tag, capability digest, expiry. | Primary **Approve and continue to signing**; secondary **Return to review**. Enter activates the focused button only; Escape/close dismisses with no effect. |
| Signer selecting/active | Clear signer name and busy indicator: **Waiting for {host/external signer}…** | Disable duplicate signer launch. Show **Cancel signing** only if it cancels the local handoff without cancelling the durable intent. |
| Signature rejected/invalid | Error: **The manifest was not accepted.** Body: **Review the manifest and sign the exact current publication intent again.** | **Review manifest**. Do not reveal whether public key, event shape, or signature caused rejection. |
| Signature expired/stale | Banner: **The signature is no longer valid for this publication.** Body: **The publication intent expired or changed. Start a new review and signing step.** | **Review capabilities**; never reuse the old event. |
| Signature accepted | Success/neutral transition: **Signature verified. Preparing the original publication operation…** | No second Publish control; automatically enter deployment observation. |
| Deployment / publication loading | Progress list, not a percentage: **Deploying sealed bytes**, **Publishing your manifest**, **Publishing CVM attestation**. Each item is pending/complete only when durably observed. | No duplicate action. A dismissible notice explains that closing the surface does not cancel reconciliation. |
| Reconciliation pending | Prominent neutral panel: **Publication status is being reconciled.** Body: **The service is checking the original publication operation. Do not sign or publish again.** | **Reconcile publication** refreshes/query-only by original operation identity. It never starts new external work. |
| Exact replay | Show the existing linked result without celebratory animation: **This publication was already processed.** | **View publication details**; no duplicate controls. Maintain quiet, fluid behavior. |
| Complete success | Summary: **Napplet published.** Include labelled links/identifiers for deployment, your manifest event, CVM build attestation, aggregate hash, and evidence. | **Copy publication details** and host-safe external links. |
| Partial success | Warning: **Publication is not complete.** List only the independently observed completed parts and the remaining operation in plain language. Never show a “published” badge. | **Reconcile publication** only; preserve linked IDs and do not request a new signature. |
| Conflict/replay mismatch | Error: **This publication request conflicts with an existing intent.** Body: **Review the current artifact and create a new publication only if you intend to publish a different verified artifact.** | Diagnostics/status only; no blind retry. |
| Terminal deployment/relay failure | Error: **Publication could not be completed.** Body: **The exact operation was recorded. Review its status before taking another action.** | **View publication status**; only server-authorized next actions may appear, never an uncontrolled retry. |

### Partial, zero/one/many, overflow, and long-content rules

- Capability collections: zero is the blocking “No manifest capabilities were returned” state above; one capability uses the same full row layout; two or more retain required-first order and an 8px divider. Never compact required and optional capability rows into unlabeled chips.
- Publication evidence: one or more completed external identifiers may be shown during partial success. Each absent item reads **Not yet confirmed**, not “missing” or “failed,” until authoritative observation says so.
- Long values: human-readable purposes wrap; hashes, event IDs, operation IDs, and d-tags middle-ellipsis in their visual field and expose a labelled copy control. The full value is available in the accessibility name and copy action, not silently truncated.
- Overflow: the inspector scrolls as a whole on desktop; capability rows and status facts must never create nested horizontal scrolling. The iframe is the only independently scrollable region.

---

## Accessibility, Keyboard, and Focus

- Use semantic landmarks: one labelled host `main`, a labelled `nav`/progress indicator for the stepper, one `section` per inspection group, and a labelled `iframe` title such as **Sealed preview of verified napplet**. The frame label, sandbox status, and preview status remain outside the iframe.
- Stepper semantics: expose current/completed/disabled state with text and `aria-current="step"` for the current stage. Disabled future steps state the prerequisite in their accessible description. Do not use disabled controls for readable status facts.
- Keyboard order follows the visual flow: header/step state, preview host controls, inspector details, then the current action. Visible focus uses the host accent ring with at least a 2px indicator and 3:1 contrast. Focus never enters hidden/disabled future-stage controls.
- Dialogs use the host runtime's modal primitive, `role="dialog"`, an explicit accessible name and description, focus trap, initial focus on the least-destructive action, and focus restoration to the invoking action. Escape closes only non-effect dialogs; it must not cancel an already-persisted publication operation.
- Buttons use visible verb-and-noun labels. Copy buttons have names such as **Copy full aggregate hash**; icon-only controls are not permitted unless the host's existing primitive supplies an equivalent visible tooltip and accessible name.
- Use `aria-live="polite"` for one-shot preview-ready, signer-return, and reconciliation changes; use `role="alert"` only for blocking integrity, incompatible-runtime, or signature/error states. Debounce polling updates and never repeatedly announce loading.
- Required/optional, compatible/incompatible, verified/unverified, and complete/partial states use text plus icon/shape in addition to color. Do not rely on a spinner alone; every busy control has an accessible busy label.
- Respect `prefers-reduced-motion`: no decorative motion; state transitions cross-fade at most 100ms or change instantly. Standard motion may use a 150ms opacity/transform transition only, with no progress illusion for external effects.

---

## Security and Privacy Presentation

- Display only allowlisted owner-safe facts: abbreviated owner fingerprint, artifact version, aggregate hash, sealed generation/checksum, capability digest, d-tag, compatible-runtime result, validated evidence reference, publication operation state, and completed public identifiers.
- Never render prompts, generated source, chain-of-thought, worker/tool output, local filesystem paths, storage locations or credentials, relay/provider-native payloads, private keys, signer tokens, delegated signing material, or raw CLI errors. Replace technical external failures with the state copy above and retain details only in protected diagnostics.
- The host must clearly distinguish **Your owning manifest** from **CVM build attestation**. The latter is provenance only and never implies CVM ownership, delegated signing, or authority to sign for the user.
- Copy-to-clipboard actions are explicit, user initiated, and limited to complete public/owner-safe identifiers. Do not auto-copy identifiers or expose full values merely on hover.
- Any received runtime message, descriptor, signed-event return, or provider status is untrusted until independently verified by the owning authority. The UI may present only the already-allowlisted safe result; it must not derive permission or workflow advancement from raw client data.

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Initial primary CTA | **Preview verified napplet** |
| Capability-review CTA | **Review capabilities** |
| Intent CTA | **Publish napplet** |
| Publish confirmation primary action | **Approve and continue to signing** |
| Host signer CTA | **Sign with this host** |
| External signer CTA | **Use external signer** |
| Reconciliation CTA | **Reconcile publication** |
| Empty state heading | **Preview not started** |
| Empty state body | **Open the exact verified artifact before preparing publication.** |
| Error state | **Publication could not be completed. The exact operation was recorded. Review its status before taking another action.** |
| Incompatible state | **This runtime cannot run the verified napplet. Choose a compatible runtime to preview and publish this artifact.** |
| Expired state | **Preview access expired. Request a new preview for this same verified artifact. No publication was started.** |
| Signature state | **The manifest was not accepted. Review the manifest and sign the exact current publication intent again.** |
| Reconciliation state | **Publication status is being reconciled. The service is checking the original publication operation. Do not sign or publish again.** |
| Partial-success state | **Publication is not complete. Some results are confirmed; reconciliation will determine the remaining result.** |
| Replay state | **This publication was already processed.** |
| Destructive confirmation | **Cancel publication review**: **Cancel review? No publication will be created.** This confirmation applies only before an intent exists. After intent creation, closing the surface never cancels or deletes the operation. |

Copy avoids “retry,” “resend,” or “publish again” for ambiguous states. It uses the concrete next actions required by D-113: `preview`, `review_capabilities`, `sign_manifest`, `publish`, and `reconcile_publication`, expressed as the corresponding user-facing labels above.

---

## UI Considerations

Applicable state considerations resolved: 20 covered, 0 backstop, 0 unresolved.

| Category | Element(s) | Status | Resolution / Reason |
|----------|------------|--------|---------------------|
| empty | sealed preview well, capability review | ✅ covered | Preview-before-start and absent-manifest states use the documented empty-state copy and block publication. |
| loading | descriptor fetch, preview frame, capability compatibility, signer handoff, deployment observation | ✅ covered | Every in-flight stage keeps verified identity visible, announces concise progress, and disables only duplicate/unsafe progression. |
| error | descriptor, preview, signature, deployment/status surfaces | ✅ covered | Each failure has a safe action path and never exposes raw provider, signer, CLI, or ownership-verification details. |
| populated | preview frame, artifact facts, capability rows, publication-result links | ✅ covered | Normal state presents the exact bound artifact and labelled owner-safe facts in the stated linear order. |
| partial | capability compatibility and multi-effect publication result | ✅ covered | Optional capability degradation is explicit; independently observed external outcomes remain partial and reconcile by original operation. |
| overflow | inspection panel, capability list, stepper | ✅ covered | Inspector is the sole host-scroll region; mobile stacks content; no nested horizontal scrolling or clipped state labels. |
| zero-one-many | capability and publication-evidence collections | ✅ covered | Zero blocks with explicit copy; one uses the full row; many preserve required-first order and labelled evidence state. |
| long-text | capability purpose, d-tag, hashes, event/operation identifiers, status copy | ✅ covered | Descriptive text wraps; identifiers use middle ellipsis with a labelled full-value copy action and accessible full name. |

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| Host runtime design system | Existing host primitives only | not a third-party registry import; no block added by this phase |
| shadcn official | none | not initialized; not applicable |
| Third-party registries | none | not applicable |

---

## Acceptance Criteria

1. The host surface presents the exact durable verified artifact's aggregate hash, sealed generation/checksum, capability digest, validation identity, and compatible-runtime identity before preview; no other artifact can be previewed or substituted.
2. The host creates the preview in a NIP-5D iframe with `sandbox="allow-scripts"` and no `allow-same-origin`; runtime messages can show only safe preview status and cannot advance publication authority.
3. The linear host flow is artifact → preview → capability/compatibility review → explicit publish approval → local/external signing → deployment/reconciliation. Future stages are unavailable until their prior gate passes.
4. Required and optional capabilities have distinct labelled rows with purpose, consent implication, and runtime compatibility. Missing required capability blocks preview/publication; missing optional capability names the graceful degradation and never offers direct authority.
5. Explicit publication approval shows the exact bound facts and requires **Approve and continue to signing**. Any artifact, manifest, d-tag, capability, runtime compatibility, or policy change invalidates prior approval/signature and returns the user to Review.
6. The signer surface offers only trusted host/external signer handoff and never accepts, stores, displays, or requests a private key, signer token, or delegated signing secret. Invalid signatures use generic safe copy.
7. Loading, empty, error, incompatible, expired, signature, reconciliation, partial-success, exact-replay, conflict, and terminal failure states render exactly as specified, with no double-sign, double-deploy, blind retry, or automatic publication affordance.
8. Partial outcomes never receive a complete/published badge. Reconciliation re-queries the original operation only, preserves already observed identifiers, and quiet exact replay returns the existing linked result.
9. Desktop uses primary preview plus side inspector; tablet/mobile stack preview before a one-section-at-a-time step sheet. All interactive targets are at least 44 × 44px and all long identifiers are accessible and copyable without layout breakage.
10. Keyboard, focus, dialog, semantic landmark, live-region, contrast, color-independent status, and reduced-motion behavior meet the Accessibility, Keyboard, and Focus contract. No user-sensitive/internal data is exposed in visual, spoken, copied, or error content.

---

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS
- [x] Dimension 2 Visuals: PASS
- [x] Dimension 3 Color: PASS
- [x] Dimension 4 Typography: PASS
- [x] Dimension 5 Spacing: PASS
- [x] Dimension 6 Registry Safety: PASS

**Approval:** verified 2026-08-05
