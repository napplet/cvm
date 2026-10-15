# Development GUI — Existing Host, Preview, and Browser Pattern Map

**Mapped:** 2026-10-15  
**Scope:** local development GUI only; excludes ContextVM transport and funding implementation details.

## What Exists Today

| Surface | Existing implementation | Reuse decision |
|---|---|---|
| Verified preview authorization | `src/publication/preview-service.ts` | Reuse `PreviewService.previewVerifiedArtifact`; it validates the exact sealed artifact and capability review before granting a 60-second read-only preview. |
| Preview contract | `src/publication/contracts.ts` | Reuse `PreviewDescriptorSchema` as the server-to-host boundary. It fixes `iframeSandbox` to `allow-scripts` and authority to `preview_read_only`. |
| GUI presentation model | `src/publication/host-surface.ts` | Reuse `projectHostPublicationSurface()` for owner-safe display data, states, actions, capability rows, accessibility, layout, and publication status. It deliberately has no DOM, transport, signer, storage, or iframe authority. |
| Host/Chromium evidence contract | `src/release/native/compatible-host.ts` | Reuse `CompatibleHostBrowserObservationPort` after providing real implementations of its two injected ports. It requires Chromium, exact sealed/aggregate identity, capability mediation, zero console errors, and desktop/tablet/mobile observation. |
| Authoritative generated-applet build | `infra/toolchain/fixture-runner.ts` | Reuse the sealed toolchain flow for every generated/revised artifact. It runs `napplet create`, `init`, skills installation, frozen offline install, `build`, `verify`, `test:conformance`, then CLI `deploy --dry-run --json`. |
| Napplet package set | `toolchains/locks/initial/package.json` | Reuse inside the sealed toolchain only: `@napplet/boilerplate@0.3.2`, `@napplet/sdk@0.27.2`, `@napplet/vite-plugin@0.14.1`, `@napplet/conformance-cli@0.2.18`, and skills `0.3.2`. |

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `src/dev-ui/host-projection.ts` | service/presenter | request-response | `src/publication/host-surface.ts` | exact projection role |
| `src/dev-ui/preview-route.ts` | route/controller | request-response + file-I/O | `src/publication/preview-service.ts` | partial: authorization exists; actual content route does not |
| `src/dev-ui/compatible-host.ts` | service/adapter | request-response + browser automation | `src/release/native/compatible-host.ts` | exact port seam, missing concrete adapter |
| `apps/dev-ui/*` (or a separate static UI root) | component/config | request-response | `fixtures/capability-harness/src/App.tsx` | only generated-applet React example; no host GUI analog |
| `tests/dev-ui/*.e2e.ts` | browser test | request-response + browser automation | `src/release/native/compatible-host.ts` | contract exact, test implementation absent |
| `scripts/dev-ui.ts` | launcher | batch/process orchestration | `infra/toolchain/fixture-runner.ts` | role-match for explicit argv and fail-closed stages |

## Pattern Assignments

### Verified preview boundary

**Copy from:** `src/publication/preview-service.ts:13-44` and `src/publication/contracts.ts:75-83`.

The GUI backend must request a descriptor through `PreviewService.previewVerifiedArtifact({ accountId, sessionId, artifactId, runtimeVariant })`. The service reads the exact verified artifact, verifies its review binds to the same artifact hash, d-tag, and runtime variant, and only then asks the host port to create a grant. The descriptor schema is strict:

```ts
export const PreviewDescriptorSchema = z.object({
  artifact: SealedArtifactIdentitySchema,
  review: CapabilityReviewSchema,
  previewGrantId: identifier,
  expiresAtMs: z.number().int().positive(),
  iframeSandbox: z.literal("allow-scripts"),
  authority: z.literal("preview_read_only"),
}).strict();
```

**Critical gap:** this descriptor intentionally contains neither a URL nor artifact bytes. There is no concrete `PreviewHostPort` or content-serving route in `src/`; the only implementation is `DeterministicPreviewHostPort` in `tests/phase-06/fakes.ts:51-64`. A development GUI must add a server-side, grant-bound artifact reader/host adapter that verifies the descriptor grant and streams only the sealed files. The browser must receive a same-purpose iframe source plus `sandbox="allow-scripts"`; do not add `allow-same-origin`, network authority, signer authority, or a raw storage URL.

### Host screen projection

**Copy from:** `src/publication/host-surface.ts:215-217, 277-296`.

Use `projectHostPublicationSurface()` as a pure UI view-model boundary, not as a replacement for lifecycle/status services. Its established contract includes the `16:10` preview panel, host-owned outer scroll and iframe-owned inner scroll, 44px targets, labelled iframe title, live announcements, required-first capability rows, and safe recovery actions. Feed it finite workflow facts only; it validates with Zod and blocks raw provider, signer, or iframe detail from presentation.

### Real compatible host and Chromium

**Copy from:** `src/release/native/compatible-host.ts:15-42, 50-84` and `src/release/deployment/compatible-host-client.ts:13-29`.

Implement these existing ports rather than inventing a mock preview:

```ts
interface CompatibleHostPackagePort {
  loadSealedNapplet(input: { sealedArtifactSha256: string; aggregateSha256: string }): Promise<{
    sealedArtifactSha256: string; aggregateSha256: string;
    hostVersion: string; packageVersion: string; runtimeVersion: string;
  }>;
}

interface CompatibleHostBrowserPort {
  readonly kind: string; // must be "chromium" for passing evidence
  observe(input: { sealedArtifactSha256: string; aggregateSha256: string;
    viewports: readonly { name: string; width: number }[];
    interactions: readonly string[] }): Promise</* browser report */>;
}
```

`CompatibleHostBrowserObservationPort` already requires 1280, 768, and 375px checks plus keyboard, touch, focus, dialog, live-region, and capability-mediation observations. The injected browser must report `kind === "chromium"`, zero console errors, denied direct authority, responsive accessibility, and mediated capabilities before it emits pass evidence (`src/release/native/compatible-host.ts:59-81`). The deployment helper advertises the canonical command pair `pnpm verify && pnpm test:conformance` (`src/release/deployment/compatible-host-client.ts:25-29`).

**Critical gap:** no concrete package-host launcher, Chromium/Playwright driver, reference host fixture, or iframe runtime exists in this workspace. Current host evidence is a contract and a fail-closed adapter, not a runnable preview runtime.

### Authoritative napplet build and conformance

**Copy from:** `infra/toolchain/fixture-runner.ts:102-121`.

The minimal safe development build method is to call the same sealed runner/image that builds verified artifacts. Its exact stage order is:

```text
napplet create → napplet init → napplet skills install →
pnpm install --offline --frozen-lockfile --ignore-scripts →
pnpm build → pnpm verify → pnpm test:conformance →
napplet deploy --dry-run --json
```

The runner then reads `dist/.nip5a-manifest.json` and requires an aggregate hash. Keep generated-applet dependencies and browser conformance in this pinned toolchain. The repository root has no Vite, React, Playwright, `@napplet/*`, or `hono` dependency and no `playwright.config.*`; root `package.json:8-51` must remain untouched under the supplied package approval constraint.

`fixtures/capability-harness/src/App.tsx:1-26` is the only local application-surface example: React uses `@napplet/sdk`'s `requireDomain()`, makes capability access explicit, checks an optional `window.napplet?.intent`, and gives a degraded real outcome. It is an artifact fixture, not a host GUI starter.

## Shared Rules for the GUI Plan

1. **Split the dev GUI from the generated napplet.** The GUI may use a separate static UI build root and a server-side development composition process. Generated applets continue through the sealed PNPM/toolchain boundary; never fold a dashboard bundle into the napplet artifact.
2. **Add a development-only authenticated local route layer, not a public generation HTTP API.** Route handlers compose existing services and expose only local loopback/dev identity state. Maintain ContextVM as the public application transport.
3. **Make preview real before showing it.** A preview request must return a safe denial until an exact artifact reader plus compatible host can load the sealed files. No data URL, `srcDoc`, fake screenshot, or deterministic host response should be shown as a verified preview.
4. **Use the current host projection for display.** Preserve its exact safe-copy/action/duplicate-guard semantics; derive GUI progress from persisted session/lifecycle data rather than fabricating stage progress in components.
5. **Browser tests must drive the local GUI plus a local compatible-host fixture in pinned Chromium.** Test the actual iframe sandbox attribute and denied direct authority, then capture the `HostBrowserEvidence` checks at 1280/768/375. Unit-only `DeterministicPreviewHostPort` is insufficient.
6. **Keep toolchain isolation.** The toolchain lock already pins Playwright `1.62.1` transitively and conformance CLI `0.2.18`; invoke it through the sealed runner. If the GUI e2e runner needs Playwright, place it in a separate UI toolchain/package with an independently locked manifest, leaving root `package.json` intact.

## No Analog Found / Required New Concrete Adapters

| Needed capability | Why it is required | Existing closest seam |
|---|---|---|
| Grant-bound sealed-artifact preview file server | `PreviewDescriptor` supplies authorization metadata but no iframe source or bytes | `PreviewHostPort.createDescriptor()` in `src/publication/contracts.ts:135-137` |
| Local compatible NIP-5D host runtime | Real preview must execute the verified napplet in the intended sandbox | `CompatibleHostPackagePort` in `src/release/native/compatible-host.ts:15-23` |
| Pinned Chromium browser driver/report collector | Existing evidence adapter only accepts an injected browser port | `CompatibleHostBrowserPort` in `src/release/native/compatible-host.ts:25-42` |
| Development GUI static bundle/server | No root UI framework, static files, Vite config, or HTTP server exists | generated-applet fixture `fixtures/capability-harness/src/App.tsx` |
| GUI browser E2E suite | No root Playwright config/test exists | `CompatibleHostBrowserObservationPort.runBrowser()` provides the acceptance contract |

## Safest Minimal Delivery Sequence

1. Build a separate, lockfile-owned local UI package and standalone launcher so the approved root manifest remains unchanged.
2. Implement local development composition that invokes real existing domain services and exposes a loopback-only control surface.
3. Implement the sealed-file reader plus grant-bound preview route and a local compatible host; connect it to `PreviewService` and enforce `allow-scripts` only.
4. Invoke the existing sealed toolchain for every artifact/revision; surface its real stage records and conformance result in the GUI.
5. Add Playwright Chromium E2E against the local GUI, local service dependencies, and local host. Assert persisted balance/spend/session facts through existing service/store reads and assert the iframe/host evidence contract.

## Metadata

**Analog search scope:** `src/publication`, `src/release/native`, `src/release/deployment`, `infra/toolchain`, `toolchains/locks`, `fixtures`, `tests/phase-06`, `tests/fixtures`  
**Conclusion:** the product has strict preview and browser-evidence contracts plus a real sealed napplet build/conformance toolchain, but it does not yet have the concrete preview host, iframe serving path, browser driver, GUI framework, or browser E2E harness needed for the requested development interface.
