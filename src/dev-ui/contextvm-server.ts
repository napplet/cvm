import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Wallet, getEncodedToken } from "@cashu/cashu-ts";
import { PrivateKeySigner } from "@contextvm/sdk/signer";
import { NostrServerTransport } from "@contextvm/sdk/transport";
import { developmentStack, type DevPayments } from "../../scripts/dev-payments";
import { AccountStatusService } from "../funding/account-status";
import { FundedAdmissionService, type ReadyCapacityPort } from "../funding/funded-admission";
import { HmacAdmissionReceiptAuthority } from "../funding/admission-receipt";
import { ContextVmFundingAdapter } from "../contextvm/adapter";
import { ContextVmSdkBridge } from "../contextvm/sdk-bridge";
import { DevelopmentNwcSettlementReconciler } from "../dev/dev-funding-reconciler";
import { createDevelopmentModelComposition } from "../dev/dev-composition";
import { MeteredGenerationService } from "../phase-04/metered-generation-service";
import { LocalNappletWorker } from "../dev/local-napplet-worker";
import { LocalArtifactVerifier } from "../dev/local-artifact-verifier";
import { LocalArtifactRepository } from "../dev/local-artifact-repository";
import { LocalPreviewGrantStore } from "../dev/local-preview-grant-store";
import { LocalGenerationArtifactVerifier, LocalProposalWorkerPort } from "../dev/local-generation-adapters";
import { createPreviewServer } from "./preview-server";
import { accountIdForPrincipal } from "../domain/account-command";
import { PHASE_04_DETERMINISTIC_PRICE_CARD, PHASE_04_MODEL_PROFILES, maximumOperationCharge } from "../model/price-card";

const root = resolve(import.meta.dir, "../..");
const reserveSat = "3750";
const actionCeilingSat = maximumOperationCharge({ card: PHASE_04_DETERMINISTIC_PRICE_CARD, profile: PHASE_04_MODEL_PROFILES["code-proposal"] });

type DevelopmentFunding = Awaited<ReturnType<typeof createDevelopmentModelComposition>>["funding"];
export type DevelopmentContextVmServer = Readonly<{
  url: string;
  stopReconciler(): void;
  restartReconciler(): void;
  assertNwcPending(): Promise<void>;
  assertFundingEvidence(caseName: "cashu-wire" | "both-rails-restart-replay"): Promise<void>;
  /** Test-only durable evidence read after a signed browser run. */
  generationEvidence(): Readonly<{ provider: string; artifactId?: string; previewUrl?: string }>;
  close(): Promise<void>;
}>;

function developmentCapacity(): ReadyCapacityPort {
  const reservations = new Map<string, Readonly<{ reference: string; expiresAt: string; binding: string }>>();
  return {
    async reserveNow(input) {
      const found = reservations.get(input.intentReference);
      const reservation = found ?? Object.freeze({ reference: `development-ready:${input.intentReference}`, expiresAt: new Date(Date.now() + 120_000).toISOString(), binding: input.expectedSessionBindingDigest });
      reservations.set(input.intentReference, reservation);
      return { status: "available" as const, reference: reservation.reference, expiresAt: reservation.expiresAt, usable: true as const, ready: { intentReference: input.intentReference, leaseReference: reservation.reference, sessionBindingDigest: reservation.binding, imageDigest: `sha256:${"1".repeat(64)}`, readinessProbeDigest: `sha256:${"2".repeat(64)}`, readyMonotonicMs: performance.now() | 0 } };
    },
    async observe(input) {
      const reservation = reservations.get(input.intentReference);
      if (!reservation || reservation.reference !== input.reference || reservation.binding !== input.expectedSessionBindingDigest) return { status: "unknown" as const, ...(input.reference ? { reference: input.reference } : {}) };
      return { status: "available" as const, reference: reservation.reference, expiresAt: reservation.expiresAt, usable: true as const, ready: { intentReference: input.intentReference, leaseReference: reservation.reference, sessionBindingDigest: reservation.binding, imageDigest: `sha256:${"1".repeat(64)}`, readinessProbeDigest: `sha256:${"2".repeat(64)}`, readyMonotonicMs: performance.now() | 0 } };
    },
    async release(input) { reservations.delete(input.intentReference); },
  };
}

async function sha256File(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
}

async function browserBundle(): Promise<string> {
  const pinoShim = resolve(root, "src/dev-ui/browser/pino-browser-shim.ts");
  const build = await Bun.build({
    entrypoints: [resolve(root, "src/dev-ui/browser/main.ts")], target: "browser", format: "esm", minify: true, write: false,
    plugins: [{ name: "contextvm-browser-pino", setup(builder) { builder.onResolve({ filter: /^pino$/ }, () => ({ path: pinoShim })); } }],
  });
  if (!build.success) throw new Error(`DEV_UI_BROWSER_BUILD_FAILED:${build.logs.map((item) => item.message).join(";")}`);
  const output = build.outputs.find((file) => file.path.endsWith(".js"));
  if (!output) throw new Error("DEV_UI_BROWSER_BUNDLE_MISSING");
  return output.text();
}

async function mintCashuToken(app: DevelopmentFunding, config: DevPayments, amount: number): Promise<string> {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10_000) throw new Error("DEV_CASHU_FAUCET_AMOUNT_INVALID");
  const wallet = new Wallet(config.mintUrl);
  await wallet.loadMint();
  const quote = await wallet.createMintQuoteBolt11(amount);
  const proofs = await wallet.mintProofsBolt11(amount, quote);
  const localToken = getEncodedToken({ mint: config.mintUrl, unit: "sat", proofs });
  return new TextDecoder().decode(app.applicationToken(localToken));
}

/**
 * Local development surface: static assets and non-secret bootstrap facts only.
 * Account and payment commands always pass through ContextVM over the relay.
 */
export async function createDevelopmentContextVmServer(options: Readonly<{ testMode?: boolean; config?: DevPayments }> = {}): Promise<DevelopmentContextVmServer> {
  const stack = options.testMode ? developmentStack(true) : undefined;
  const config = options.config ?? (stack ? await stack.up() : await Bun.file(resolve(root, ".local/napplet-cvm-dev-payments/payments.json")).json() as DevPayments);
  const composition = await createDevelopmentModelComposition(config);
  const app = composition.funding;
  const signer = new PrivateKeySigner();
  const transport = new NostrServerTransport({ signer, relayHandler: [config.relayUrl], encryptionMode: "required", publishRelayList: false, injectRequestEventId: true, logLevel: "silent" });
  const bridge = new ContextVmSdkBridge(transport);
  const accountStatus = new AccountStatusService({
    store: app.database.funding,
    sessions: { list: async () => ({ active: [], resumable: [], pendingActions: [] }) },
    rails: app.database.railStatuses,
  });
  const receipts = new HmacAdmissionReceiptAuthority({ secret: crypto.getRandomValues(new Uint8Array(32)) });
  const fundedAdmission = new FundedAdmissionService({ funding: app.funding, store: app.database.funding, capacity: developmentCapacity(), receiptAuthority: receipts });
  const repository = new LocalArtifactRepository({ objectRoot: resolve(root, ".local/development-artifacts"), pool: app.pool });
  const grants = new LocalPreviewGrantStore({ pool: app.pool });
  const worker = new LocalProposalWorkerPort(new LocalNappletWorker());
  const owners = new Map<string, string>();
  const artifactVerifier = new LocalGenerationArtifactVerifier({ worker, verifier: new LocalArtifactVerifier(), repository, ownerIdForAccount: (accountId) => owners.get(accountId) });
  const generation = new MeteredGenerationService({ fundedAdmission, store: app.database.meteredFunding, gateway: composition.gateway, worker, artifactVerifier, proposalStore: composition.proposals });
  const paja = await import("../../tests/dev-ui/node_modules/@kehto/paja");
  const previewServer = await createPreviewServer({ repository, grants, paja: { startPajaServer: paja.startPajaServer, domains: paja.PAJA_SIMULATION_DOMAINS } });
  let latestPreviewUrl: string | undefined;
  const preview = {
    async previewVerifiedArtifact(input: Readonly<{ accountId: string; sessionId: string; artifactId: string }>) {
      const artifact = await repository.get(input.artifactId);
      if (!artifact || artifact.accountId !== input.accountId || artifact.sessionId !== input.sessionId) return { state: "denied" as const, nextAction: "preview" as const, safeReasonCode: "preview_not_available" as const };
      const grant = await grants.create({ ownerId: artifact.ownerId, accountId: artifact.accountId, sessionId: artifact.sessionId, artifact });
      latestPreviewUrl = await previewServer.openPaja(grant.token);
      return { state: "ready" as const, artifactId: artifact.artifactId, aggregateSha256: artifact.aggregateSha256, previewGrantId: grant.previewGrantId, expiresAtMs: grant.expiresAtMs, previewUrl: latestPreviewUrl, nextAction: "review_capabilities" as const };
    },
    async reviewCapabilities(input: Readonly<{ artifactId: string }>) {
      const artifact = await repository.get(input.artifactId);
      return artifact ? { state: "ready" as const, artifactId: artifact.artifactId, aggregateSha256: artifact.aggregateSha256, capabilityDigest: artifact.verificationEvidenceSha256, runtimeVariant: "development-paja-0.19.0", required: [], optional: [], nextAction: "sign_manifest" as const } : { state: "denied" as const, nextAction: "preview" as const, safeReasonCode: "preview_not_available" as const };
    },
  };
  const generationFacade = {
    async startSession(input: any) { owners.set(await accountIdForPrincipal(input.principal), input.principal.pubkey); return generation.startSession(input); },
    async reviseSession(input: any) { owners.set(await accountIdForPrincipal(input.principal), input.principal.pubkey); return generation.reviseSession(input); },
  };
  new ContextVmFundingAdapter({ service: app.funding, transport: bridge, admissions: fundedAdmission, admissionReceipts: receipts, accountStatus, topUps: { lightning: app.lightning, cashu: app.cashu }, generation: generationFacade, preview, policyVersion: "development-local-v1" });
  let reconciler = new DevelopmentNwcSettlementReconciler(app);
  const [html, javascript, servicePubkey] = await Promise.all([
    readFile(resolve(root, "src/dev-ui/browser/index.html"), "utf8"), browserBundle(), signer.getPublicKey(),
  ]);
  await transport.start();
  reconciler.start();

  const web = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return new Response("loopback only", { status: 403 });
      if (url.pathname === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (url.pathname === "/app.js") return new Response(javascript, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
      if (url.pathname === "/bootstrap") return Response.json({ relayUrl: config.relayUrl, servicePubkey, reserveSat, actionCeilingSat }, { headers: { "cache-control": "no-store" } });
      if (url.pathname === "/dev/faucet/cashu" && request.method === "POST") {
        try {
          const amount = Number(url.searchParams.get("amount"));
          return Response.json({ token: await mintCashuToken(app, config, amount) }, { headers: { "cache-control": "no-store" } });
        } catch { return Response.json({ code: "faucet_rejected" }, { status: 400 }); }
      }
      if (url.pathname === "/health") return Response.json({ status: "ok" });
      return new Response("not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${web.port}`;

  return Object.freeze({
    url,
    stopReconciler: () => reconciler.stop(),
    restartReconciler: () => { reconciler.stop(); reconciler = new DevelopmentNwcSettlementReconciler(app); reconciler.start(); },
    async assertNwcPending() {
      const last = bridge.lastInbound;
      if (!last) throw new Error("DEV_UI_SIGNED_EVENT_EVIDENCE_MISSING");
      const topUps = await app.database.lightning.transact((state) => [...state.topUps.values()]
        .filter((topUp) => topUp.principal.pubkey === last.verifiedClientPubkey));
      if (topUps.length !== 1 || topUps[0]?.state !== "pending" || !topUps[0].protectedMaterialId) throw new Error("DEV_UI_NWC_PENDING_ROW_MISSING");
      const status = await accountStatus.status({ pubkey: last.verifiedClientPubkey });
      if (status.available !== "64") throw new Error("DEV_UI_NWC_CREDITED_BEFORE_RESTART");
    },
    async assertFundingEvidence(caseName) {
      const last = bridge.lastInbound;
      if (!last || !/^[a-f0-9]{64}$/.test(last.verifiedClientPubkey) || !/^[a-f0-9]{64}$/.test(last.requestEventId)) throw new Error("DEV_UI_SIGNED_EVENT_EVIDENCE_MISSING");
      for (const method of ["initialize", "tools/list", "tools/call", "notifications/initialized"]) {
        if (!bridge.observedMethods.has(method)) throw new Error(`DEV_UI_MCP_LIFECYCLE_MISSING:${method}`);
      }
      const status = await accountStatus.status({ pubkey: last.verifiedClientPubkey });
      const expected = caseName === "cashu-wire" ? "64" : "3814";
      if (status.available !== expected) throw new Error(`DEV_UI_BALANCE_MISMATCH:${status.available}`);
      const credits = await app.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM ledger_entries WHERE account_id=$1 AND direction='credit'", [status.accountId]);
      if (credits.rows[0]?.count !== (caseName === "cashu-wire" ? 1 : 2)) throw new Error("DEV_UI_LEDGER_REPLAY_MISMATCH");
      const [packageHash, lockHash] = await Promise.all([sha256File(resolve(root, "package.json")), sha256File(resolve(root, "bun.lock"))]);
      if (packageHash !== "cbcc433278d32391b075576ebd847ae30039f1d86ad229a149f5566856989f23" || lockHash !== "8916ee4ec92924ae9e09bc4f315fd6656033812696e35a1b7785161d872c5ac3") throw new Error("DEV_UI_ROOT_MANIFEST_DRIFT");
    },
    generationEvidence: () => Object.freeze({ provider: composition.providerLabel, ...(latestPreviewUrl ? { previewUrl: latestPreviewUrl } : {}) }),
    async close() {
      reconciler.stop();
      try { web.stop(true); }
      finally {
        await previewServer.close();
        // Relay shutdown is best-effort in the local SDK; do not leave a
        // browser evidence run holding containers forever on a lost close ACK.
        try { await Promise.race([transport.close().catch(() => undefined), Bun.sleep(1_000)]); }
        finally {
          try { await composition.close(); }
          finally { if (stack) await stack.down(true); }
        }
      }
    },
  });
}

if (import.meta.main) {
  const server = await createDevelopmentContextVmServer();
  console.log(`Development ContextVM funding workspace: ${server.url}`);
  const stop = async () => { await server.close(); process.exit(0); };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  await new Promise<void>(() => undefined);
}
