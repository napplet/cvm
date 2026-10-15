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
import { MeteredGenerationService, type SessionActionResult } from "../phase-04/metered-generation-service";
import { LocalNappletWorker } from "../dev/local-napplet-worker";
import { LocalArtifactVerifier } from "../dev/local-artifact-verifier";
import { LocalArtifactRepository } from "../dev/local-artifact-repository";
import { LocalPreviewGrantStore } from "../dev/local-preview-grant-store";
import { LocalGenerationArtifactVerifier, LocalProposalWorkerPort } from "../dev/local-generation-adapters";
import { createPreviewServer } from "./preview-server";
import { accountIdForPrincipal } from "../domain/account-command";
import { PHASE_04_DETERMINISTIC_PRICE_CARD, PHASE_04_MODEL_PROFILES, maximumOperationCharge } from "../model/price-card";
import { LocalDevelopmentRuntimeReadiness, type DevelopmentRuntimeReadiness } from "../dev/development-runtime-readiness";
import { ContinuationService } from "../continuity/continuation-service";
import { developmentServiceIdentity } from "../dev/local-service-identity";
import { LocalCheckpointStore } from "../dev/local-checkpoint-store";
import { PendingActionEnvelopeService } from "../continuity/checkpoint-envelope";
import { PreAdmissionSessionService } from "../continuity/pre-admission-session-service";
import { readSessionStatus } from "../phase-04/session-status";
import { DurableWorkerResultStore } from "../dev/durable-worker-result-store";

const root = resolve(import.meta.dir, "../..");
const reserveSat = "3750";

type DevelopmentFunding = Awaited<ReturnType<typeof createDevelopmentModelComposition>>["funding"];
export type DevelopmentContextVmServer = Readonly<{
  url: string;
  stopReconciler(): void;
  restartReconciler(): void;
  assertNwcPending(): Promise<void>;
  assertFundingEvidence(caseName: "cashu-wire" | "both-rails-restart-replay"): Promise<void>;
  /** Test-only SQL-to-projection equality check for the signed generation result. */
  assertGenerationSettlement(): Promise<void>;
  /** Test-only durable evidence read after a signed browser run. */
  generationEvidence(): Readonly<{ provider: string; result?: SessionActionResult; artifactId?: string; previewUrl?: string; error?: string }>;
  close(): Promise<void>;
}>;

function developmentCapacity(readiness: DevelopmentRuntimeReadiness): ReadyCapacityPort {
  const reservations = new Map<string, Readonly<{ reference: string; expiresAt: string; binding: string }>>();
  return {
    async reserveNow(input) {
      const found = reservations.get(input.intentReference);
      const reservation = found ?? Object.freeze({ reference: `development-ready:${input.intentReference}`, expiresAt: new Date(Date.now() + 120_000).toISOString(), binding: input.expectedSessionBindingDigest });
      reservations.set(input.intentReference, reservation);
      return { status: "available" as const, reference: reservation.reference, expiresAt: reservation.expiresAt, usable: true as const, ready: { intentReference: input.intentReference, leaseReference: reservation.reference, sessionBindingDigest: reservation.binding, imageDigest: readiness.imageDigest, readinessProbeDigest: readiness.readinessProbeDigest, readyMonotonicMs: readiness.readyMonotonicMs } };
    },
    async observe(input) {
      const reservation = reservations.get(input.intentReference);
      if (!reservation || reservation.reference !== input.reference || reservation.binding !== input.expectedSessionBindingDigest) return { status: "unknown" as const, ...(input.reference ? { reference: input.reference } : {}) };
      return { status: "available" as const, reference: reservation.reference, expiresAt: reservation.expiresAt, usable: true as const, ready: { intentReference: input.intentReference, leaseReference: reservation.reference, sessionBindingDigest: reservation.binding, imageDigest: readiness.imageDigest, readinessProbeDigest: readiness.readinessProbeDigest, readyMonotonicMs: readiness.readyMonotonicMs } };
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

async function durableTimeline(app: DevelopmentFunding, accountId: string, sessionId: string): Promise<readonly Readonly<{ stage: "source_recorded" | "provider_recorded" | "worker_completed" | "artifact_verified" | "ledger_settled"; at: string; detail: string }>[]> {
  const rows = await app.pool.query<{ stage: "source_recorded" | "provider_recorded" | "worker_completed" | "artifact_verified" | "ledger_settled"; at: Date | string; detail: string }>(`
    SELECT 'source_recorded'::text AS stage, sp.created_at AS at, 'Source proposal recorded' AS detail FROM source_proposals sp WHERE sp.account_id=$1 AND sp.session_id=$2
    UNION ALL SELECT 'provider_recorded'::text, po.created_at, 'Provider receipt recorded' FROM provider_observations po JOIN source_proposals sp ON sp.operation_id=po.operation_id WHERE sp.account_id=$1 AND sp.session_id=$2
    UNION ALL SELECT 'worker_completed'::text, wr.completed_at, 'Isolated worker output persisted' FROM development_worker_results wr WHERE wr.account_id=$1 AND wr.session_id=$2 AND wr.completed_at IS NOT NULL
    UNION ALL SELECT 'artifact_verified'::text, da.created_at, 'Verified artifact sealed' FROM development_artifacts da WHERE da.account_id=$1 AND da.session_id=$2
    UNION ALL SELECT 'ledger_settled'::text, bli.committed_at, 'Metered ledger settled' FROM billing_line_items bli WHERE bli.account_id=$1 AND bli.session_id=$2 AND bli.kind IN ('receipt','debit')
    ORDER BY at, stage`, [accountId, sessionId]);
  return Object.freeze(rows.rows.map((row) => Object.freeze({ stage: row.stage, at: new Date(row.at).toISOString(), detail: row.detail })));
}

/**
 * Local development surface: static assets and non-secret bootstrap facts only.
 * Account and payment commands always pass through ContextVM over the relay.
 */
export async function createDevelopmentContextVmServer(options: Readonly<{ testMode?: boolean; config?: DevPayments; stateRoot?: string; port?: number }> = {}): Promise<DevelopmentContextVmServer> {
  const stack = options.testMode ? developmentStack(true) : undefined;
  const config = options.config ?? (stack ? await stack.up() : await Bun.file(resolve(root, ".local/napplet-cvm-dev-payments/payments.json")).json() as DevPayments);
  let priorSource: ((input: Readonly<{ accountId: string; sessionId: string; authorizedPriorArtifactReference: string }>) => Promise<readonly { path: "src/main.ts" | "src/styles.css"; content: string }[] | undefined>) | undefined;
  const composition = await createDevelopmentModelComposition(config, { priorSource: async (input) => priorSource?.(input) });
  const app = composition.funding;
  const stateRoot = resolve(options.stateRoot ?? resolve(root, ".local"));
  const actionCeilingSat = composition.pricing
    ? maximumOperationCharge(composition.pricing)
    : maximumOperationCharge({ card: PHASE_04_DETERMINISTIC_PRICE_CARD, profile: PHASE_04_MODEL_PROFILES["code-proposal"] });
  const readiness = await new LocalDevelopmentRuntimeReadiness().assertReady();
  const identity = developmentServiceIdentity(config.fundingKey);
  const signer = new PrivateKeySigner(identity.signerPrivateKey);
  const transport = new NostrServerTransport({ signer, relayHandler: [config.relayUrl], encryptionMode: "required", publishRelayList: false, injectRequestEventId: true, logLevel: "silent" });
  const bridge = new ContextVmSdkBridge(transport);
  const accountStatus = new AccountStatusService({
    store: app.database.funding,
    sessions: { list: async ({ accountId }) => {
      const [sessions, pending] = await Promise.all([
        app.pool.query<{ id: string; state: string }>("SELECT id,state FROM metered_sessions WHERE account_id=$1 ORDER BY id", [accountId]),
        app.pool.query<{ checkpoint_id: string; state: string }>("SELECT checkpoint_id,state FROM development_pending_actions WHERE account_id=$1 AND state IN ('saved','bound') ORDER BY created_at", [accountId]),
      ]);
      return {
        active: sessions.rows.filter((row) => ["prepared", "active", "usage_unknown"].includes(row.state)).map((row) => ({ id: row.id })),
        resumable: sessions.rows.filter((row) => row.state === "needs_top_up").map((row) => ({ id: row.id })),
        pendingActions: pending.rows.map((row) => ({ id: row.checkpoint_id, state: row.state === "bound" ? "authorized" as const : "pending" as const })),
      };
    } },
    rails: app.database.railStatuses,
  });
  const receipts = new HmacAdmissionReceiptAuthority({ secret: identity.admissionSecret });
  const fundedAdmission = new FundedAdmissionService({ funding: app.funding, store: app.database.funding, capacity: developmentCapacity(readiness), receiptAuthority: receipts });
  const repository = new LocalArtifactRepository({ objectRoot: resolve(stateRoot, "development-artifacts"), pool: app.pool });
  const grants = new LocalPreviewGrantStore({ pool: app.pool });
  const worker = new LocalProposalWorkerPort(new LocalNappletWorker({ image: readiness.imageDigest }), { results: new DurableWorkerResultStore({ pool: app.pool, toolchainSha256: readiness.imageDigest.slice("sha256:".length), root: resolve(stateRoot, "development-worker-results") }) });
  const owners = new Map<string, string>();
  const artifactVerifier = new LocalGenerationArtifactVerifier({ worker, verifier: new LocalArtifactVerifier(), repository, ownerIdForAccount: (accountId) => owners.get(accountId) });
  const generation = new MeteredGenerationService({ fundedAdmission, store: app.database.meteredFunding, gateway: composition.gateway, worker, artifactVerifier, proposalStore: composition.proposals, continuation: new ContinuationService({ store: app.database.meteredFunding, includeAdmissionHold: true }), ...(composition.pricing ? { pricing: composition.pricing } : {}) });
  const pricing = composition.pricing ?? { card: PHASE_04_DETERMINISTIC_PRICE_CARD, profile: PHASE_04_MODEL_PROFILES["code-proposal"] };
  const [packageHash, lockHash] = await Promise.all([sha256File(resolve(root, "package.json")), sha256File(resolve(root, "bun.lock"))]);
  const preAdmission = new PreAdmissionSessionService({
    store: app.database.meteredFunding,
    envelope: new PendingActionEnvelopeService(new LocalCheckpointStore({ root: resolve(stateRoot, "development-checkpoints") })),
    generation,
    pricing,
    pins: { policyVersion: "development-local-v1", profileId: pricing.profile.id, priceCardId: pricing.card.id, toolchainId: readiness.imageDigest, rootManifestSha256: new Bun.CryptoHasher("sha256").update(`${packageHash}:${lockHash}`).digest("hex") },
  });
  priorSource = async (input) => {
    const artifact = await repository.get(input.authorizedPriorArtifactReference);
    if (!artifact || artifact.accountId !== input.accountId || artifact.sessionId !== input.sessionId) return undefined;
    const source = (await app.pool.query<{ proposal_json: { files?: unknown } }>("SELECT proposal_json FROM source_proposals WHERE proposal_sha256=$1 AND account_id=$2 AND session_id=$3 AND action_id=$4", [artifact.proposalSha256, input.accountId, input.sessionId, artifact.actionId])).rows[0]?.proposal_json;
    const files = source && typeof source === "object" && Array.isArray((source as { files?: unknown }).files) ? (source as { files: unknown[] }).files : undefined;
    if (!files) return undefined;
    const parsed = files.filter((file): file is { path: "src/main.ts" | "src/styles.css"; content: string } => typeof file === "object" && file !== null && ((file as { path?: unknown }).path === "src/main.ts" || (file as { path?: unknown }).path === "src/styles.css") && typeof (file as { content?: unknown }).content === "string");
    return parsed.length === files.length ? parsed : undefined;
  };
  const paja = await import("../../tests/dev-ui/node_modules/@kehto/paja");
  const previewServer = await createPreviewServer({ repository, grants, paja: { startPajaServer: paja.startPajaServer, domains: paja.PAJA_SIMULATION_DOMAINS } });
  let latestPreviewUrl: string | undefined; let latestGenerationError: string | undefined; let latestGenerationResult: SessionActionResult | undefined;
  const preview = {
    async previewVerifiedArtifact(input: Readonly<{ accountId: string; sessionId: string; artifactId: string }>) {
      const artifact = await repository.get(input.artifactId);
      if (!artifact || artifact.accountId !== input.accountId || artifact.sessionId !== input.sessionId) return { state: "denied" as const, nextAction: "preview" as const, safeReasonCode: "preview_not_available" as const };
      const grant = await grants.create({ ownerId: artifact.ownerId, accountId: artifact.accountId, sessionId: artifact.sessionId, artifact });
      latestPreviewUrl = await previewServer.openPaja(grant.token);
      return { state: "ready" as const, artifactId: artifact.artifactId, aggregateSha256: artifact.aggregateSha256, previewGrantId: grant.previewGrantId, expiresAtMs: grant.expiresAtMs, previewUrl: latestPreviewUrl, nextAction: "review_capabilities" as const };
    },
    async reviewCapabilities(input: Readonly<{ accountId: string; sessionId: string; artifactId: string }>) {
      const artifact = await repository.get(input.artifactId);
      return artifact && artifact.accountId === input.accountId && artifact.sessionId === input.sessionId ? { state: "ready" as const, artifactId: artifact.artifactId, aggregateSha256: artifact.aggregateSha256, capabilityDigest: artifact.verificationEvidenceSha256, runtimeVariant: "development-paja-0.19.0", required: [], optional: [], nextAction: "sign_manifest" as const } : { state: "denied" as const, nextAction: "preview" as const, safeReasonCode: "preview_not_available" as const };
    },
  };
  const generationFacade = {
    async startSession(input: any) { try { owners.set(await accountIdForPrincipal(input.principal), input.principal.pubkey); return latestGenerationResult = await generation.startSession(input); } catch (error) { latestGenerationError = error instanceof Error ? error.message : "GENERATION_UNKNOWN_ERROR"; throw error; } },
    async reviseSession(input: any) { try { owners.set(await accountIdForPrincipal(input.principal), input.principal.pubkey); return latestGenerationResult = await generation.reviseSession(input); } catch (error) { latestGenerationError = error instanceof Error ? error.message : "GENERATION_UNKNOWN_ERROR"; throw error; } },
  };
  const preAdmissionFacade = {
    async saveStart(input: any) {
      const result = await preAdmission.saveStart(input);
      return result.status === "saved" ? { ...result, nextAction: "funded_admission" as const } : result;
    },
    async status(input: any) {
      const record = await preAdmission.status(input);
      if (!record) return { status: "not_found_or_denied" as const };
      const balance = await app.database.funding.status(record.accountId);
      const base = { checkpointId: record.checkpointId, reference: record.reference, fingerprint: record.commandFingerprint, maximum: record.maximum, version: 1 as const, expiresAtMs: record.expiresAtMs };
      if (record.state === "saved") return { status: "saved" as const, ...base, shortfall: (BigInt(record.maximum) > BigInt(balance?.available ?? "0") ? BigInt(record.maximum) - BigInt(balance?.available ?? "0") : 0n).toString(), nextAction: "funded_admission" as const };
      if (record.state === "bound") return { status: "bound" as const, ...base, nextAction: "wait_for_current_action" as const };
      return { status: record.state, ...base, nextAction: record.state === "completed" ? "revise_session" as const : "retry_resume" as const };
    },
    async resume(input: any) {
      try {
        owners.set(input.owner.accountId, input.owner.ownerId);
        return latestGenerationResult = await preAdmission.resume(input);
      } catch (error) {
        latestGenerationError = error instanceof Error ? error.message : "GENERATION_UNKNOWN_ERROR";
        throw error;
      }
    },
  };
  new ContextVmFundingAdapter({ service: app.funding, transport: bridge, admissions: fundedAdmission, admissionReceipts: receipts, accountStatus, topUps: { lightning: app.lightning, cashu: app.cashu }, generation: generationFacade, preAdmission: preAdmissionFacade, sessionStatus: { read: async (query: any) => {
    const result = await readSessionStatus({ store: app.database.meteredFunding, query, cursorSecret: identity.cursorSecret });
    if (result.status !== "ok") return result;
    const accountId = await accountIdForPrincipal(query.principal);
    return { ...result, timeline: await durableTimeline(app, accountId, query.sessionId) };
  } }, preview, policyVersion: "development-local-v1" });
  let reconciler = new DevelopmentNwcSettlementReconciler(app);
  const [html, javascript, servicePubkey] = await Promise.all([
    readFile(resolve(root, "src/dev-ui/browser/index.html"), "utf8"), browserBundle(), signer.getPublicKey(),
  ]);
  await transport.start();
  reconciler.start();

  const web = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return new Response("loopback only", { status: 403 });
      if (url.pathname === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (url.pathname === "/app.js") return new Response(javascript, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
      if (url.pathname === "/styles.css") return new Response(await Bun.file(resolve(root, "src/dev-ui/browser/styles.css")).text(), { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" } });
      if (url.pathname === "/bootstrap") return Response.json({ relayUrl: config.relayUrl, servicePubkey, reserveSat, actionCeilingSat, providerLabel: composition.providerLabel }, { headers: { "cache-control": "no-store" } });
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
    async assertGenerationSettlement() {
      const result = latestGenerationResult;
      if (!result || (result.status !== "completed" && result.status !== "failed")) throw new Error("DEV_UI_GENERATION_RESULT_MISSING");
      const row = (await app.pool.query<{ receipt_charge: string; remaining_cap_sat: string; remaining_balance_sat: string; artifact_id: string | null; terminal_result: unknown }>("SELECT receipt_charge,remaining_cap_sat,remaining_balance_sat,artifact_id,terminal_result FROM metered_actions WHERE account_id=$1 AND operation_id=$2", [result.accountId, result.operationId])).rows[0];
      if (!row || row.receipt_charge !== result.confirmedSpend || row.remaining_cap_sat !== result.remainingCap || row.remaining_balance_sat !== result.remainingBalance || (result.status === "completed" && row.artifact_id !== result.artifactId)) throw new Error("DEV_UI_GENERATION_SQL_PROJECTION_MISMATCH");
    },
    generationEvidence: () => Object.freeze({ provider: composition.providerLabel, ...(latestGenerationResult ? { result: latestGenerationResult } : {}), ...(latestPreviewUrl ? { previewUrl: latestPreviewUrl } : {}), ...(latestGenerationError ? { error: latestGenerationError } : {}) }),
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
