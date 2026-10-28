import { spawn } from "node:child_process";
import { z } from "zod";
import type { CompatibleHostBrowserPort, CompatibleHostPackagePort } from "../release/native/compatible-host";

const Digest = z.string().regex(/^[a-f0-9]{64}$/iu);
const Status = z.enum(["pass", "blocked", "not_observed"]);
const Url = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(url.hostname));
}, "COMPATIBLE_HOST_URL_INVALID");
const Viewport = z.object({ name: z.string().min(1).max(64), width: z.number().int().min(1).max(10_000) }).strict();
const ObservationInput = z.object({
  sealedArtifactSha256: Digest,
  aggregateSha256: Digest,
  viewports: z.array(Viewport).min(1).max(3),
  interactions: z.array(z.string().min(1).max(64)).max(16),
}).strict();
const BrowserObservation = z.object({
  viewportWidthPx: z.number().int().positive(),
  screenshotSha256: Digest,
  reportSha256: Digest,
  layout: Status,
  targets: Status,
  accessibility: Status,
  keyboardFocus: Status,
  dialog: Status,
  liveRegion: Status,
  contrast: Status,
  reducedMotion: Status,
  stateInventory: Status,
  identifierCoverage: Status,
  minimumMeasuredTargetPx: z.number().int().min(44),
  noClippedStepLabels: z.literal(true),
  noNestedHorizontalScroll: z.literal(true),
}).strict();
const BrowserResult = z.object({
  browserVersion: z.string().min(1).max(256),
  consoleErrors: z.array(z.string().max(2_048)).max(16),
  observations: z.array(BrowserObservation).min(1).max(3),
  hostPreview: Status,
  hostSigner: Status,
  externalSigner: Status,
  reconciliation: Status,
  launchCertificationBlockedState: Status,
}).strict();
const Diagnostics = z.object({
  console: z.array(z.string().max(512)).max(16),
  pageErrors: z.array(z.string().max(512)).max(16),
  requests: z.array(z.string().max(512)).max(24),
  page: z.object({
    readyState: z.string().max(32),
    lifecycleStatus: z.string().max(128).nullable(),
    iframePresent: z.boolean(),
    iframeHasSrcdoc: z.boolean(),
    iframeSandbox: z.string().max(128).nullable(),
  }).strict().optional(),
}).strict();
const DriverMessage = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: BrowserResult }).strict(),
  z.object({ ok: z.literal(false), error: z.string().min(1).max(2_048), diagnostics: Diagnostics.optional() }).strict(),
]);

const MAX_DRIVER_OUTPUT_BYTES = 64 * 1024;
const DRIVER_GRACE_MS = 5_000;
const DRIVER_TERMINATE_GRACE_MS = 2_500;

/* This runs in a short-lived Node process because Paja's shipped ESM entrypoint
 * and Playwright use Node's module/runtime contract. It emits exactly one,
 * bounded JSON record after its cleanup has finished. */
const DRIVER = String.raw`
import { createHash } from "node:crypto";

const input = JSON.parse(process.env.NAPPLET_CHROMIUM_INPUT);
const limit = (value, size = 512) => String(value).replace(/[\r\n]+/g, " ").slice(0, size);
const append = (values, value, max) => { if (values.length < max) values.push(limit(value)); };
const hash = (value) => createHash("sha256").update(value).digest("hex");
let browser;
let paja;
let page;
let closed = false;
const diagnostics = { console: [], pageErrors: [], requests: [] };
const startedAt = Date.now();

const remaining = () => Math.max(1, input.timeoutMs - (Date.now() - startedAt));
const within = (stage, task) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("COMPATIBLE_HOST_" + stage + "_TIMEOUT")), remaining());
  Promise.resolve().then(task).then(resolve, reject).finally(() => clearTimeout(timer));
});
const settle = async (task) => {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(task),
      new Promise((resolve) => { timer = setTimeout(resolve, 1_000); }),
    ]);
  } catch {} finally { clearTimeout(timer); }
};
const snapshot = async () => {
  if (!page) return undefined;
  try {
    let timer;
    return await Promise.race([
      page.evaluate(() => {
        const frame = document.querySelector("#napplet-frame");
        return {
          readyState: document.readyState,
          lifecycleStatus: document.querySelector("#lifecycle-status")?.textContent?.slice(0, 128) ?? null,
          iframePresent: frame instanceof HTMLIFrameElement,
          iframeHasSrcdoc: frame instanceof HTMLIFrameElement && frame.hasAttribute("srcdoc"),
          iframeSandbox: frame instanceof HTMLIFrameElement ? frame.getAttribute("sandbox") : null,
        };
      }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), 500); }),
    ]).finally(() => clearTimeout(timer));
  } catch { return undefined; }
};
const close = async () => {
  if (closed) return;
  closed = true;
  await settle(() => browser?.close());
  await settle(() => paja?.close());
};
const terminated = () => { void close().finally(() => process.exit(143)); };
process.once("SIGTERM", terminated);
process.once("SIGINT", terminated);

let message;
try {
  const pinned = await within("HOST_PIN", async () => {
    const response = await fetch(input.pinUrl, { redirect: "error", signal: AbortSignal.timeout(remaining()) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return response.ok && hash(bytes) === input.hostSha256;
  });
  if (!pinned) throw new Error("COMPATIBLE_HOST_PIN_MISMATCH");
  const { startPajaServer } = await import(process.env.NAPPLET_PAJA_ENTRY);
  const { chromium } = await import(process.env.NAPPLET_PLAYWRIGHT_ENTRY);
  paja = await startPajaServer({ options: {
    host: "127.0.0.1", port: 0, targetUrl: input.targetUrl,
    simulation: {
      capabilities: { domains: {} }, acl: { mode: "deny" }, firewall: { mode: "deny" }, identity: { mode: "anonymous" },
      relay: { mode: "disabled" }, storage: { mode: "disabled" }, cache: { mode: "disabled" }, upload: { mode: "disabled" },
      media: { enabled: false }, notifications: { enabled: false, grant: false }, intent: { enabled: false }, cvm: { enabled: false },
    },
  } });
  browser = await chromium.launch({ executablePath: input.executable, headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (entry) => append(diagnostics.console, entry.type() + ":" + entry.text(), 16));
  page.on("pageerror", (error) => append(diagnostics.pageErrors, error.message, 16));
  page.on("requestfailed", (request) => append(diagnostics.requests, "failed:" + new URL(request.url()).pathname + ":" + (request.failure()?.errorText ?? "unknown"), 24));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === new URL(paja.url).origin) append(diagnostics.requests, response.status() + ":" + url.pathname, 24);
  });
  await page.goto(paja.url, { waitUntil: "domcontentloaded", timeout: remaining() });
  const frameElement = await within("IFRAME_ATTACH", async () => {
    await page.locator("#napplet-frame").waitFor({ state: "attached", timeout: remaining() });
    return page.$("#napplet-frame");
  });
  if (!frameElement) throw new Error("COMPATIBLE_HOST_IFRAME_MISSING");
  await within("TARGET_SRCDOC", () => page.waitForFunction(() => document.querySelector("#napplet-frame")?.hasAttribute("srcdoc") === true, undefined, { timeout: remaining() }));
  const frame = await within("IFRAME_CONTENT", () => frameElement.contentFrame());
  if (!frame) throw new Error("COMPATIBLE_HOST_IFRAME_MISSING");
  const sandbox = await within("IFRAME_SANDBOX", () => frameElement.getAttribute("sandbox"));
  const shellReady = await within("SHELL_READY", () => frame.evaluate(async () => {
    if (!window.napplet?.shell?.ready) return false;
    await window.napplet.shell.ready();
    return true;
  }));
  const lifecycleReady = await within("PAJA_LIFECYCLE", async () => (await page.locator("#lifecycle-status").textContent({ timeout: remaining() })) === "ready");
  const pajaWireReady = ["200:/", "200:/__kehto/browser-host.js", "200:/__kehto/config.json", "200:/__kehto/target.html", "200:/__kehto/target-cors.json"].every((entry) => diagnostics.requests.includes(entry));
  const authority = await within("AUTHORITY_PROBE", () => frame.evaluate(async () => {
    let parentStorageBlocked = false;
    let directFetchBlocked = false;
    try { void parent.localStorage.length; } catch { parentStorageBlocked = true; }
    try { await fetch("https://authority.invalid/forbidden"); } catch { directFetchBlocked = true; }
    return { opaqueOrigin: location.origin === "null", parentStorageBlocked, directFetchBlocked, nostrAbsent: typeof window.nostr === "undefined" };
  }));
  // These are the literal UI-contract labels, rather than action IDs. A host
  // that has not exposed this trusted presentation surface remains blocked;
  // the probe never substitutes a fixture value for missing host evidence.
  const identifierContract = {
    aggregate_hash: ["Aggregate hash", "Full aggregate hash:", "Copy full aggregate hash"],
    normalized_d_tag: ["d-tag", "Full normalized d-tag:", "Copy full normalized d-tag"],
    capability_digest: ["Capability digest", "Full capability digest:", "Copy full capability digest"],
    admission_reference: ["Admission reference", "Full admission reference:", "Copy full admission reference"],
    publication_intent: ["Publication intent", "Full publication intent:", "Copy full publication intent"],
    publication_operation: ["Publication operation", "Full publication operation:", "Copy full publication operation"],
    owner_manifest_event: ["Your manifest event", "Full owning manifest event identifier:", "Copy full manifest event identifier"],
    cvm_attestation: ["CVM build attestation", "Full CVM build attestation identifier:", "Copy full CVM build attestation identifier"],
    deployment: ["Deployment", "Full deployment identifier:", "Copy full deployment identifier"],
    evidence_reference: ["Evidence reference", "Full evidence reference:", "Copy full evidence reference"],
  };
  const requiredStateCopy = [
    "Starting isolated workspace…", "Capacity is temporarily unavailable.", "No session was started and no funds were reserved.", "Try admission again",
    "Checking verified artifact…", "Preview not started", "Open the exact verified artifact before preparing publication.", "Preview verified napplet",
    "Opening sealed preview…", "Preview ready", "Review capabilities", "This runtime cannot run the verified napplet.",
    "Choose a compatible runtime to preview and publish this artifact.", "Preview access expired.", "Request a new preview for this same verified artifact. No publication was started.",
    "Preview is unavailable for this artifact.", "Return to the verified artifact and review its status.", "Checking runtime compatibility…",
    "No manifest capabilities were returned.", "Publication cannot continue until the verified manifest is available.", "Required — unavailable in this runtime.",
    "Optional — unavailable in this runtime.", "Ready for publication approval.", "Publish napplet", "Review changed — publication approval was cleared.",
    "Artifact, capability, compatibility, d-tag, or policy details changed. Review the exact current details before signing.", "Publish this verified napplet?",
    "You are approving deployment of the sealed artifact shown here and publication of your signed manifest. You will sign next.", "Approve and continue to signing", "Return to review",
    "Waiting for host signer…", "Waiting for external signer…", "Cancel signing", "The manifest was not accepted.",
    "Review the manifest and sign the exact current publication intent again.", "Review manifest", "The signature is no longer valid for this publication.",
    "The publication intent expired or changed. Start a new review and signing step.", "Signature verified. Preparing the original publication operation…",
    "Deploying sealed bytes", "Publishing your manifest", "Publishing CVM attestation", "Closing this surface does not cancel reconciliation.",
    "Publication status is being reconciled.", "The service is checking the original publication operation. Do not sign or publish again.", "Reconcile publication",
    "This publication was already processed.", "View publication details", "Napplet published.", "Copy publication details", "Publication is not complete.",
    "Some results are confirmed; reconciliation will determine the remaining result.", "Not yet confirmed", "This publication request conflicts with an existing intent.",
    "Review the current artifact and create a new publication only if you intend to publish a different verified artifact.", "Publication could not be completed.",
    "The exact operation was recorded. Review its status before taking another action.", "View publication status", "Launch certification is blocked.",
    "Required live evidence is missing, stale, failed, skipped, or not observed. Production promotion is unavailable.", "View release evidence",
  ];
  const observations = [];
  for (const viewport of input.viewports) {
    await within("VIEWPORT", () => page.setViewportSize({ width: viewport.width, height: 800 }));
    // Paja's development chrome has a fixed default target viewport. Resize
    // the actual sandbox iframe (rather than emulating a DOM width) so each
    // requested contract breakpoint is rendered by Chromium itself.
    await within("TARGET_VIEWPORT", () => frameElement.evaluate((element, width) => {
      element.style.setProperty("width", width + "px", "important");
      element.style.setProperty("height", "800px", "important");
    }, viewport.width));
    const measurement = await within("TARGET_MEASUREMENT", () => frame.evaluate(() => {
      const targets = [...document.querySelectorAll("button,a,input,[role=button]")].filter((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      const boxes = targets.map((element) => element.getBoundingClientRect());
      return {
        count: targets.length,
        minimum: boxes.length === 0 ? 0 : Math.floor(Math.min(...boxes.map((box) => Math.min(box.width, box.height)))),
        labelled: targets.every((element) => (element.textContent?.trim().length ?? 0) > 0 || element.getAttribute("aria-label")?.trim()),
        overflowing: [...document.querySelectorAll("*")].some((element) => element.scrollWidth > element.clientWidth && getComputedStyle(element).overflowX === "visible"),
      };
    }));
    let keyboardFocus = false;
    if (measurement.count > 0) {
      await within("KEYBOARD_FOCUS", () => frame.locator("button,a,input,[role=button]").first().focus({ timeout: remaining() }));
      keyboardFocus = await within("KEYBOARD_FOCUS_CHECK", () => frame.evaluate(() => document.activeElement?.matches("button,a,input,[role=button]") ?? false));
    }
    const contract = await within("HOST_CONTRACT_MEASUREMENT", () => frame.evaluate((input) => {
      const visible = (element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const parseColor = (value) => {
        const match = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/u);
        return match && Number(match[4] ?? "1") > 0 ? match.slice(1, 4).map(Number) : undefined;
      };
      const relativeLuminance = ([r, g, b]) => [r, g, b].map((component) => {
        const channel = component / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      }).reduce((value, channel, index) => value + channel * [0.2126, 0.7152, 0.0722][index], 0);
      const contrastRatio = (foreground, background) => {
        const a = relativeLuminance(foreground);
        const b = relativeLuminance(background);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      const root = document.querySelector("[data-cvm-host-contract]");
      const grid = document.querySelector("[data-cvm-layout-grid]");
      const preview = document.querySelector("[data-cvm-preview-well]");
      const inspector = document.querySelector("[data-cvm-inspector]");
      const currentSections = [...document.querySelectorAll("[data-cvm-step-section][data-cvm-current-section]")].filter(visible);
      const allSections = [...document.querySelectorAll("[data-cvm-step-section]")];
      const nextAction = document.querySelector("[data-cvm-next-action]");
      const readable = [...document.querySelectorAll("[data-cvm-readable]")];
      const visibleReadable = readable.filter(visible);
      const typography = visibleReadable.length > 0 && visibleReadable.every((element) => {
        const style = getComputedStyle(element);
        return ["14px", "16px", "20px", "28px"].includes(style.fontSize) && ["400", "600"].includes(style.fontWeight) && visible(element);
      });
      const desktop = (() => {
        if (!grid || !preview || !inspector || input.width < 1024) return false;
        const previewBox = preview.getBoundingClientRect();
        const inspectorBox = inspector.getBoundingClientRect();
        const gap = inspectorBox.left - previewBox.right;
        const primaryShare = previewBox.width / (previewBox.width + inspectorBox.width);
        return primaryShare >= 0.6 && primaryShare <= 0.66 && Math.abs(gap - 32) <= 1 && Math.abs((previewBox.width / previewBox.height) - 1.6) <= 0.03;
      })();
      const tablet = input.width >= 768 && input.width < 1024
        ? allSections.length >= 2 && allSections.every(visible) && grid && getComputedStyle(grid).gridTemplateColumns.split(" ").length === 1
        : false;
      const mobile = (() => {
        if (input.width >= 768 || !grid || !nextAction || !root) return false;
        const action = nextAction.getBoundingClientRect();
        const parentStyle = getComputedStyle(nextAction.parentElement);
        const parent = nextAction.parentElement.getBoundingClientRect();
        const availableWidth = parent.width - parseFloat(parentStyle.paddingLeft) - parseFloat(parentStyle.paddingRight);
        return currentSections.length === 1 && getComputedStyle(grid).gridTemplateColumns.split(" ").length === 1 && action.width >= availableWidth - 1;
      })();
      const stateText = document.querySelector("[data-cvm-state-inventory]")?.textContent ?? "";
      const statusNodes = [...document.querySelectorAll("[data-cvm-semantic-status]")];
      const colorIndependent = statusNodes.length > 0 && statusNodes.every((element) => visible(element) && (element.textContent?.trim().length ?? 0) > 0 && Boolean(element.querySelector("[data-cvm-status-shape]")));
      const contrast = [...document.querySelectorAll("[data-cvm-contrast]")].map((element) => {
        const style = getComputedStyle(element);
        const foreground = parseColor(style.color);
        let background;
        for (let node = element; node && !background; node = node.parentElement) {
          const candidate = parseColor(getComputedStyle(node).backgroundColor);
          if (candidate) background = candidate;
        }
        return foreground && background ? contrastRatio(foreground, background) : 0;
      });
      const focusTarget = document.querySelector("[data-cvm-focus-target]");
      const focusStyle = focusTarget ? getComputedStyle(focusTarget) : undefined;
      const focusVisible = Boolean(focusTarget && document.activeElement === focusTarget && focusStyle && parseFloat(focusStyle.outlineWidth) >= 2 && parseColor(focusStyle.outlineColor) && parseColor(getComputedStyle(document.body).backgroundColor) && contrastRatio(parseColor(focusStyle.outlineColor), parseColor(getComputedStyle(document.body).backgroundColor)) >= 3);
      const identifiers = [...document.querySelectorAll("[data-cvm-identifier-kind]")].map((element) => ({
        kind: element.getAttribute("data-cvm-identifier-kind"), label: element.querySelector("[data-cvm-identifier-label]")?.textContent?.trim() ?? "",
        display: element.querySelector("[data-cvm-identifier-display]")?.textContent?.trim() ?? "", accessibleName: element.getAttribute("aria-label") ?? "",
        copyLabel: element.querySelector("button")?.getAttribute("aria-label") ?? "", copyTarget: element.querySelector("button")?.getAttribute("data-cvm-copy-kind") ?? "",
      }));
      const copyButtons = [...document.querySelectorAll("button[data-cvm-copy-kind]")];
      return {
        present: Boolean(root), desktop, tablet, mobile, typography,
        landmarks: Boolean(document.querySelector("main[aria-label]")) && Boolean(document.querySelector("nav[aria-label]")) && Boolean(document.querySelector("[aria-current=step]")) && [...document.querySelectorAll("[aria-disabled=true]")].every((element) => Boolean(element.getAttribute("aria-describedby"))),
        stateCopy: input.requiredStateCopy.every((copy) => stateText.includes(copy)), colorIndependent,
        contrast, focusVisible, identifiers, copyButtons: copyButtons.length,
        targetWidthFits: document.documentElement.scrollWidth <= window.innerWidth,
      };
    }, { width: viewport.width, requiredStateCopy }));
    const dialog = await within("DIALOG_MEASUREMENT", async () => {
      const opener = frame.locator("[data-cvm-dialog-open]");
      if (await opener.count() !== 1) return false;
      await opener.click({ timeout: remaining() });
      const opened = await frame.evaluate(() => {
        const dialog = document.querySelector("dialog[data-cvm-dialog]");
        const described = dialog?.getAttribute("aria-describedby");
        const initialFocus = dialog?.querySelector("[data-cvm-dialog-initial]");
        const targets = [...(dialog?.querySelectorAll("button,a,input,[role=button]") ?? [])];
        const targetsSized = targets.length > 0 && targets.every((element) => {
          const box = element.getBoundingClientRect();
          return Math.min(box.width, box.height) >= 44;
        });
        return { open: Boolean(dialog?.open), contract: Boolean(dialog?.open && dialog.getAttribute("role") === "dialog" && dialog.getAttribute("aria-labelledby") && described && document.getElementById(described) && initialFocus === document.activeElement && targetsSized) };
      });
      if (!opened.open) return false;
      await page.keyboard.press("Escape");
      const restored = await frame.evaluate(() => {
        const dialog = document.querySelector("dialog[data-cvm-dialog]");
        return !dialog?.open && document.activeElement?.matches("[data-cvm-dialog-open]") === true;
      });
      return opened.contract && restored;
    });
    const liveRegion = await within("LIVE_REGION_MEASUREMENT", async () => {
      const trigger = frame.locator("[data-cvm-live-trigger]");
      if (await trigger.count() !== 1) return false;
      const before = await frame.locator("[data-cvm-live-region]").textContent().catch(() => null);
      if (before === "Preview ready") return frame.evaluate(() => document.querySelector("[data-cvm-live-region]")?.getAttribute("aria-live") === "polite" && document.querySelector("[data-cvm-live-count]")?.textContent === "1");
      await trigger.click({ timeout: remaining() });
      await trigger.click({ timeout: remaining() });
      return frame.evaluate((previous) => {
        const region = document.querySelector("[data-cvm-live-region]");
        const count = document.querySelector("[data-cvm-live-count]")?.textContent;
        return region?.getAttribute("aria-live") === "polite" && region.textContent?.trim() === "Preview ready" && region.textContent !== previous && count === "1";
      }, before);
    });
    const reducedMotion = await within("REDUCED_MOTION_MEASUREMENT", async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      try {
        return await frame.evaluate(() => [...document.querySelectorAll("[data-cvm-motion]")].every((element) => {
          const style = getComputedStyle(element);
          const milliseconds = (value) => value.split(",").every((duration) => {
            const trimmed = duration.trim();
            return trimmed === "0s" || trimmed === "0ms" || (trimmed.endsWith("ms") && Number.parseFloat(trimmed) <= 100) || (trimmed.endsWith("s") && Number.parseFloat(trimmed) <= 0.1);
          });
          return milliseconds(style.transitionDuration) && milliseconds(style.animationDuration);
        }) && document.querySelectorAll("[data-cvm-motion]").length > 0);
      } finally { await page.emulateMedia({ reducedMotion: "no-preference" }); }
    });
    const identifierCoverage = contract.present && Object.entries(identifierContract).every(([kind, [label, accessiblePrefix, copyLabel]]) => {
      const identifier = contract.identifiers.find((candidate) => candidate.kind === kind);
      return identifier && identifier.label === label && identifier.display.includes("…") && identifier.accessibleName.startsWith(accessiblePrefix) && identifier.copyLabel === copyLabel && identifier.copyTarget === kind;
    }) && contract.identifiers.length === Object.keys(identifierContract).length && contract.copyButtons === Object.keys(identifierContract).length;
    if (identifierCoverage) {
      for (const kind of Object.keys(identifierContract)) {
        await within("IDENTIFIER_COPY", () => frame.locator('button[data-cvm-copy-kind="' + kind + '"]').click({ timeout: remaining() }));
        const copied = await within("IDENTIFIER_COPY_RESULT", () => frame.evaluate((copiedKind) => document.querySelector("[data-cvm-copy-status]")?.textContent === "Copied " + copiedKind, kind));
        if (!copied) throw new Error("COMPATIBLE_HOST_IDENTIFIER_COPY_FAILED:" + kind);
      }
    }
    const screenshot = await within("SCREENSHOT", () => page.screenshot());
    const targetsPass = measurement.count > 0 && measurement.minimum >= 44 && measurement.labelled;
    const layoutPass = contract.present && contract.typography && (contract.desktop || contract.tablet || contract.mobile);
    const accessibilityPass = contract.present && contract.landmarks && contract.colorIndependent && contract.focusVisible;
    const contrastPass = contract.present && contract.contrast.length > 0 && contract.contrast.every((ratio) => ratio >= 4.5);
    const report = { viewportWidthPx: viewport.width, measurement, contract, keyboardFocus, dialog, liveRegion, reducedMotion, authority, lifecycleReady, pajaWireReady };
    observations.push({
      viewportWidthPx: viewport.width,
      screenshotSha256: hash(screenshot),
      reportSha256: hash(JSON.stringify(report)),
      layout: layoutPass ? "pass" : "blocked",
      targets: targetsPass ? "pass" : "blocked",
      accessibility: accessibilityPass ? "pass" : "blocked",
      keyboardFocus: keyboardFocus ? "pass" : "blocked",
      dialog: dialog ? "pass" : "blocked",
      liveRegion: liveRegion ? "pass" : "blocked",
      contrast: contrastPass ? "pass" : contract.present ? "blocked" : "not_observed",
      reducedMotion: reducedMotion ? "pass" : contract.present ? "blocked" : "not_observed",
      stateInventory: contract.present && contract.stateCopy ? "pass" : "blocked",
      identifierCoverage: identifierCoverage ? "pass" : "blocked",
      minimumMeasuredTargetPx: measurement.minimum,
      noClippedStepLabels: !measurement.overflowing,
      noNestedHorizontalScroll: contract.targetWidthFits,
    });
  }
  if (observations.some((observation) => observation.minimumMeasuredTargetPx < 44 || !observation.noClippedStepLabels || !observation.noNestedHorizontalScroll)) {
    throw new Error("COMPATIBLE_HOST_LAYOUT_MEASUREMENT_FAILED:" + JSON.stringify(observations.map((observation) => ({ width: observation.viewportWidthPx, minimum: observation.minimumMeasuredTargetPx, clipped: observation.noClippedStepLabels, scroll: observation.noNestedHorizontalScroll }))));
  }
  let authorityConsoleSkipped = false;
  const authorityProbeFailed = diagnostics.requests.some((entry) => entry.startsWith("failed:/forbidden:"));
  const consoleErrors = diagnostics.console.filter((entry) => {
    if (!entry.startsWith("error:") || /Content Security Policy|connect-src/u.test(entry)) return false;
    if (!authorityConsoleSkipped && authorityProbeFailed && entry === "error:Failed to load resource: net::ERR_NAME_NOT_RESOLVED") {
      authorityConsoleSkipped = true;
      return false;
    }
    return true;
  }).map((entry) => entry.slice("error:".length));
  message = { ok: true, result: {
    browserVersion: browser.version(),
    consoleErrors,
    observations,
    hostPreview: shellReady && lifecycleReady && pajaWireReady && sandbox === "allow-scripts" && authority.opaqueOrigin && authority.parentStorageBlocked && authority.directFetchBlocked && authority.nostrAbsent ? "pass" : "blocked",
    hostSigner: "blocked",
    externalSigner: "blocked",
    reconciliation: "blocked",
    launchCertificationBlockedState: "not_observed",
  } };
} catch (error) {
  message = { ok: false, error: limit(error, 2_048), diagnostics: { ...diagnostics, page: await snapshot() } };
}
await close();
process.removeListener("SIGTERM", terminated);
process.removeListener("SIGINT", terminated);
process.stdout.write(JSON.stringify(message) + "\n", () => process.exit(0));
`;

function targetUrl(hostUrl: string, sealedArtifactSha256: string, aggregateSha256: string): string {
  const url = new URL(hostUrl);
  url.searchParams.set("sealed", sealedArtifactSha256);
  url.searchParams.set("aggregate", aggregateSha256);
  return url.toString();
}

async function terminate(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => setTimeout(resolve, DRIVER_TERMINATE_GRACE_MS));
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function runDriver(input: Readonly<{ pinUrl: string; hostSha256: string; targetUrl: string; executable: string; timeoutMs: number; viewports: readonly z.infer<typeof Viewport>[] }>): Promise<z.infer<typeof DriverMessage>> {
  const child = spawn("node", ["--input-type=module", "--eval", DRIVER], {
    env: {
      ...process.env,
      NAPPLET_CHROMIUM_INPUT: JSON.stringify(input),
      NAPPLET_PAJA_ENTRY: new URL("../../tests/dev-ui/node_modules/@kehto/paja/dist/index.js", import.meta.url).href,
      NAPPLET_PLAYWRIGHT_ENTRY: new URL("../../tests/dev-ui/node_modules/playwright/index.mjs", import.meta.url).href,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (action: () => void) => { if (!settled) { settled = true; clearTimeout(deadline); action(); } };
    const deadline = setTimeout(() => {
      void terminate(child).finally(() => settle(() => reject(new Error("COMPATIBLE_HOST_DRIVER_HARD_TIMEOUT"))));
    }, input.timeoutMs + DRIVER_GRACE_MS);
    const append = (current: string, chunk: Buffer): string | undefined => {
      const next = current + chunk.toString("utf8");
      return Buffer.byteLength(next, "utf8") <= MAX_DRIVER_OUTPUT_BYTES ? next : undefined;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const next = append(stdout, chunk);
      if (next === undefined) void terminate(child).finally(() => settle(() => reject(new Error("COMPATIBLE_HOST_DRIVER_STDOUT_LIMIT"))));
      else stdout = next;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const next = append(stderr, chunk);
      if (next === undefined) void terminate(child).finally(() => settle(() => reject(new Error("COMPATIBLE_HOST_DRIVER_STDERR_LIMIT"))));
      else stderr = next;
    });
    child.once("error", (error) => settle(() => reject(error)));
    child.once("close", (code, signal) => settle(() => {
      if (code !== 0) return reject(new Error(`COMPATIBLE_HOST_DRIVER_EXIT:${code ?? "null"}:${signal ?? "none"}:${stderr.slice(0, 2_048)}`));
      try { resolve(DriverMessage.parse(JSON.parse(stdout))); }
      catch (error) { reject(new Error(`COMPATIBLE_HOST_DRIVER_PROTOCOL_INVALID:${error instanceof Error ? error.message : String(error)}`)); }
    }));
  });
}

/** Process-owned headless Chromium probe. The compatible host receives only
 * candidate identities; it receives no account, signer, or provider material. */
export class ProductionChromiumCompatibleHost implements CompatibleHostBrowserPort {
  readonly kind = "chromium";
  readonly #hostUrl: string;
  readonly #hostSha256: string;
  readonly #executable: string;
  readonly #timeoutMs: number;

  constructor(input: Readonly<{ hostUrl: string; hostSha256: string; chromiumExecutable: string; timeoutMs?: number }>) {
    this.#hostUrl = Url.parse(input.hostUrl);
    this.#hostSha256 = Digest.parse(input.hostSha256).toLowerCase();
    if (!input.chromiumExecutable.startsWith("/") || /[\0\r\n]/u.test(input.chromiumExecutable)) throw new Error("CHROMIUM_EXECUTABLE_INVALID");
    this.#executable = input.chromiumExecutable;
    this.#timeoutMs = input.timeoutMs ?? 20_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1_000 || this.#timeoutMs > 60_000) throw new Error("CHROMIUM_TIMEOUT_INVALID");
  }

  async observe(input: Readonly<{ sealedArtifactSha256: string; aggregateSha256: string; viewports: readonly { name: string; width: number }[]; interactions: readonly string[] }>) {
    const observation = ObservationInput.parse(input);
    const result = await runDriver({
      pinUrl: this.#hostUrl,
      hostSha256: this.#hostSha256,
      targetUrl: targetUrl(this.#hostUrl, observation.sealedArtifactSha256, observation.aggregateSha256),
      executable: this.#executable,
      timeoutMs: this.#timeoutMs,
      viewports: observation.viewports,
    });
    if (!result.ok && result.error === "Error: COMPATIBLE_HOST_PIN_MISMATCH") throw new Error("COMPATIBLE_HOST_PIN_MISMATCH");
    if (!result.ok) throw new Error(`COMPATIBLE_HOST_DRIVER_FAILED:${result.error}:${JSON.stringify(result.diagnostics ?? {})}`);
    return Object.freeze(result.result);
  }
}

/** Read-only companion to the Chromium probe. It verifies the pinned host
 * document before asking that same host for immutable package metadata. A
 * missing endpoint/header is blocked rather than replaced with mounted
 * versions, so certification cannot manufacture host evidence from config. */
export class ProductionCompatibleHostPackage implements CompatibleHostPackagePort {
  readonly #hostUrl: string;
  readonly #hostSha256: string;
  readonly #timeoutMs: number;

  constructor(input: Readonly<{ hostUrl: string; hostSha256: string; timeoutMs?: number }>) {
    this.#hostUrl = Url.parse(input.hostUrl);
    this.#hostSha256 = Digest.parse(input.hostSha256).toLowerCase();
    this.#timeoutMs = input.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1_000 || this.#timeoutMs > 60_000) throw new Error("COMPATIBLE_HOST_TIMEOUT_INVALID");
  }

  async loadSealedNapplet(input: Readonly<{ sealedArtifactSha256: string; aggregateSha256: string }>) {
    const sealedArtifactSha256 = Digest.parse(input.sealedArtifactSha256).toLowerCase();
    const aggregateSha256 = Digest.parse(input.aggregateSha256).toLowerCase();
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const pinned = await fetch(this.#hostUrl, { redirect: "error", signal });
    const bytes = new Uint8Array(await pinned.arrayBuffer());
    const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (!pinned.ok || actual !== this.#hostSha256) throw new Error("COMPATIBLE_HOST_PIN_MISMATCH");
    const endpoint = new URL(this.#hostUrl);
    endpoint.searchParams.set("sealed", sealedArtifactSha256);
    endpoint.searchParams.set("aggregate", aggregateSha256);
    endpoint.searchParams.set("metadata", "1");
    const response = await fetch(endpoint, { redirect: "error", signal });
    const metadata = z.object({
      sealedArtifactSha256: Digest, aggregateSha256: Digest,
      hostVersion: z.string().min(1).max(256), packageVersion: z.string().min(1).max(256), runtimeVersion: z.string().min(1).max(256),
    }).strict().safeParse(await response.json().catch(() => undefined));
    if (!response.ok || !metadata.success || metadata.data.sealedArtifactSha256 !== sealedArtifactSha256 || metadata.data.aggregateSha256 !== aggregateSha256) {
      throw new Error("COMPATIBLE_HOST_PACKAGE_UNAVAILABLE");
    }
    return Object.freeze(metadata.data);
  }
}
