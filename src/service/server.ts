import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EncryptionMode } from "@contextvm/sdk/core";
import { PrivateKeySigner } from "@contextvm/sdk/signer";
import { NostrServerTransport } from "@contextvm/sdk/transport";
import { finalizeEvent } from "nostr-tools/pure";
import { AccountStatusService } from "../funding/account-status";
import { FundedAdmissionService } from "../funding/funded-admission";
import { HmacAdmissionReceiptAuthority } from "../funding/admission-receipt";
import { ContextVmFundingAdapter } from "../contextvm/adapter";
import { ContextVmSdkBridge } from "../contextvm/sdk-bridge";
import { MeteredGenerationService, SessionActionResultSchema, type SessionActionResult } from "../phase-04/metered-generation-service";
import { readSessionStatus } from "../phase-04/session-status";
import { ContinuationService } from "../continuity/continuation-service";
import { PendingActionEnvelopeService } from "../continuity/checkpoint-envelope";
import { PreAdmissionSessionService } from "../continuity/pre-admission-session-service";
import { accountIdForPrincipal } from "../domain/account-command";
import { maximumOperationCharge, PHASE_04_DETERMINISTIC_PRICE_CARD, PHASE_04_MODEL_PROFILES, type ModelProfile, type PriceCard } from "../model/price-card";
import { DevelopmentModelGateway, configuredProviderFromEnvironment } from "../dev/development-model-gateway";
import { SourceProposalStore } from "../dev/source-proposal-store";
import { registerDevelopmentPricing } from "../dev/register-development-pricing";
import { DevelopmentNwcSettlementReconciler } from "../dev/dev-funding-reconciler";
import { LocalNappletWorker, configureUntrustedContainerRuntime } from "../dev/local-napplet-worker";
import { LocalArtifactVerifier } from "../dev/local-artifact-verifier";
import { LocalArtifactRepository } from "../dev/local-artifact-repository";
import { LocalPreviewGrantStore } from "../dev/local-preview-grant-store";
import { LocalGenerationArtifactVerifier, LocalProposalWorkerPort } from "../dev/local-generation-adapters";
import { LocalDevelopmentRuntimeReadiness } from "../dev/development-runtime-readiness";
import { DurableWorkerResultStore } from "../dev/durable-worker-result-store";
import { DevelopmentProjects } from "../dev/projects";
import { ProjectRevisions } from "../dev/project-revisions";
import { InterruptedDevelopmentGeneration } from "../dev/interrupted-generation";
import { LocalPublication } from "../dev/local-publication";
import { readGenerationEstimates } from "../dev/generation-estimates";
import { ServiceInfoArgumentsSchema } from "../dev-ui/extension-schemas";
import { createPreviewServer } from "../dev-ui/preview-server";
import { buildStaticWorkspace } from "../dev-ui/static-assets";
import { DevelopmentProgressTransport } from "../dev-ui/development-progress";
import { developmentCapacity, durableTimeline, safeGenerationDiagnostic } from "../dev-ui/contextvm-server";
import { deriveServiceIdentity, readMountedFile, ServiceSecrets, type ServiceConfig } from "./config";
import { createServiceFunding, type ServicePool } from "./funding";
import { assertCanonicalSchema, assertServiceRealm } from "./migrations";

const root = resolve(import.meta.dir, "../..");
const { Pool } = createRequire(import.meta.url)("pg") as { Pool: new (options: Record<string, unknown>) => ServicePool };

export function createServicePool(databaseUrl: string, config: Pick<ServiceConfig, "database">): ServicePool {
  const url = new URL(databaseUrl);
  if (!["postgresql:", "postgres:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1) || url.hash) throw new Error("SERVICE_DATABASE_URL_INVALID");
  return new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, query_timeout: config.database.statementTimeoutMs, max: config.database.maxConnections });
}

/** Server-side pending-action checkpoint key, derived from the mounted service seed. */
class MountedPendingActionKey {
  readonly #keyId: string;
  constructor(private readonly key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error("SERVICE_PENDING_KEY_INVALID");
    this.#keyId = `service-pending:${new Bun.CryptoHasher("sha256").update("napplet-cvm/pending-key-id/v1").update(key).digest("hex")}`;
  }
  async loadOrCreatePendingActionKey() { return Object.freeze({ keyId: this.#keyId, key: new Uint8Array(this.key) }); }
}

export type ServiceRuntime = Readonly<{
  url: string;
  servicePubkey: string;
  realm: ServiceConfig["realm"];
  /** Durable checks used by the deployment verifier; no secret or balance mutation. */
  status(): Promise<Readonly<{ realm: string; servicePubkey: string; workerImage: string; workerRuntime: string; model: string; migrations: "current" }>>;
  close(): Promise<void>;
}>;

/**
 * The service composition root. Every deployment uses this one composition;
 * configuration selects concrete adapters (PostgreSQL, filesystem storage,
 * OpenAI Responses, Docker worker runtime, NIP-47 and Cashu rails). It never
 * mints funds, exposes a faucet, or carries certification/migration machinery.
 */
export async function createServiceRuntime(input: Readonly<{ config: ServiceConfig; secrets?: ServiceSecrets; hostname?: string }>): Promise<ServiceRuntime> {
  const { config } = input;
  const secrets = input.secrets ?? new ServiceSecrets();
  const identity = deriveServiceIdentity(await secrets.text("service_seed"));
  const pool = createServicePool(await secrets.text("database_url"), config);
  const closers: Array<() => Promise<unknown> | unknown> = [() => pool.end()];
  const close = async () => { for (const closer of closers.reverse()) await Promise.resolve().then(closer).catch(() => undefined); };
  try {
    // Schema and realm are prerequisites established by `scripts/migrate.ts`.
    await assertCanonicalSchema(pool);
    await assertServiceRealm(pool, config.realm);
    const storage = resolve(config.storage.root);
    for (const directory of ["artifacts", "worker-results", "published"]) await mkdir(resolve(storage, directory), { recursive: true, mode: 0o700 });

    const app = await createServiceFunding({
      pool, fundingKey: identity.fundingKey, nwcUri: await secrets.text("nwc_uri"), nwcPolicy: config.realm === "real" ? "tls" : "private-test",
      settlementPrefix: config.realm === "real" ? "nwc" : "test-nwc", mints: config.funding.cashu.mints, mintPolicyVersion: config.funding.cashu.mintPolicyVersion,
      allowMintRoutes: config.realm === "test",
    });

    // Paid generation: OpenAI Responses with exact usage receipts and lookup
    // reconciliation. The deterministic adapter exists only for the test realm.
    const proposals = new SourceProposalStore(app.pool);
    let configured: Awaited<ReturnType<typeof configuredProviderFromEnvironment>>;
    let pricing: { card: PriceCard; profile: ModelProfile };
    if (config.model.adapter === "openai-responses") {
      const pricingDocument = JSON.parse(new TextDecoder().decode(await readMountedFile(config.model.pricingFile, 256_000)));
      configured = await configuredProviderFromEnvironment({ apiKey: await secrets.text("openai_api_key"), model: pricingDocument.model, profile: pricingDocument.profile, priceCard: pricingDocument.priceCard, priceSources: pricingDocument.priceSources });
      if (!configured) throw new Error("SERVICE_MODEL_REQUIRED");
      pricing = { card: configured.priceCard, profile: configured.profile };
    } else {
      if (config.realm !== "test") throw new Error("SERVICE_TEST_MODEL_DENIED");
      configured = undefined;
      pricing = { card: PHASE_04_DETERMINISTIC_PRICE_CARD, profile: PHASE_04_MODEL_PROFILES["code-proposal"] };
    }
    await registerDevelopmentPricing(app.pool, { profile: pricing.profile, priceCard: pricing.card });
    const repository = new LocalArtifactRepository({ objectRoot: resolve(storage, "artifacts"), pool: app.pool });
    let priorSource: ConstructorParameters<typeof DevelopmentModelGateway>[0]["priorSource"];
    const gateway = new DevelopmentModelGateway({ store: proposals, ...(configured ? { configured } : {}), priorSource: async (value) => priorSource?.(value) });
    if ((config.model.adapter === "openai-responses") !== (gateway.label() === "Configured OpenAI Responses")) throw new Error("SERVICE_MODEL_ADAPTER_MISMATCH");

    // Isolated worker: the configured Docker engine and OCI runtime, probed before listening.
    configureUntrustedContainerRuntime(config.worker.runtime);
    const readiness = await new LocalDevelopmentRuntimeReadiness({ image: config.worker.image, runtime: config.worker.runtime }).assertReady();
    const signer = new PrivateKeySigner(identity.signerPrivateKey);
    const servicePubkey = await signer.getPublicKey();
    // Public identity marker for backups and operators; never a secret.
    await writeFile(resolve(storage, "service-pubkey"), `${servicePubkey}\n`, { mode: 0o644 });
    const transport = new NostrServerTransport({ signer, relayHandler: [config.relay.url], encryptionMode: EncryptionMode.REQUIRED, publishRelayList: false, injectRequestEventId: true, logLevel: "silent" });
    // `development_publication` is the historical name of the user-signed publication tool.
    const bridge = new ContextVmSdkBridge(transport, ["service_info", "projects", "development_publication"]);
    const progress = new DevelopmentProgressTransport(bridge);
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
    const grants = new LocalPreviewGrantStore({ pool: app.pool });
    const worker = new LocalProposalWorkerPort(new LocalNappletWorker({ image: readiness.imageDigest, runtime: config.worker.runtime, onProgress: (stage, state, diagnostic) => progress.emit(stage, state, diagnostic ? { diagnostic } : {}) }), { results: new DurableWorkerResultStore({ pool: app.pool, toolchainSha256: readiness.imageDigest.slice("sha256:".length), root: resolve(storage, "worker-results") }) });
    const owners = new Map<string, string>();
    const artifactVerifier = new LocalGenerationArtifactVerifier({ worker, verifier: new LocalArtifactVerifier(), repository, ownerIdForAccount: (accountId) => owners.get(accountId) });
    const generation = new MeteredGenerationService({
      automaticValidationRepair: true,
      fundedAdmission, store: app.database.meteredFunding,
      gateway: progress.gateway({
        dispatch: async (intent, signal) => {
          if (intent.prompt.length <= 512) await app.pool.query("UPDATE metered_actions SET request_text=$4 WHERE account_id=$1 AND id=$2 AND operation_id=$3 AND request_text IS NULL", [intent.accountId, intent.actionId, intent.operationId, intent.prompt]).catch(() => undefined);
          return gateway.dispatch(intent, signal);
        },
        lookup: (intent, signal) => gateway.lookup(intent, signal),
      }, { provider: pricing.profile.provider, model: pricing.profile.model }),
      worker: { run: async (...args) => { const result = await worker.run(...args); if (result.status !== "completed") progress.emit("worker", "failed"); return result; } },
      artifactVerifier: { verify: async (facts) => {
        progress.emit("artifact", "running");
        try { const result = await artifactVerifier.verify(facts); progress.emit("artifact", result ? "completed" : "failed"); return result; }
        catch (error) { progress.emit("artifact", "failed"); throw error; }
      } },
      telemetry: { observe(event) { if (event.stage === "ledger_settlement" && event.outcome === "succeeded") progress.emit("ledger", "completed"); } },
      proposalStore: proposals,
      continuation: new ContinuationService({ store: app.database.continuationFunding, includeAdmissionHold: true }), pricing,
    });
    const [packageHash, lockHash] = await Promise.all(["package.json", "bun.lock"].map(async (name) => new Bun.CryptoHasher("sha256").update(await readFile(resolve(root, name))).digest("hex")));
    const preAdmission = new PreAdmissionSessionService({ store: app.database.funding, envelope: new PendingActionEnvelopeService(new MountedPendingActionKey(identity.pendingActionKey)), generation, pricing,
      pins: { policyVersion: config.policy.version, profileId: pricing.profile.id, priceCardId: pricing.card.id, toolchainId: readiness.imageDigest, rootManifestSha256: new Bun.CryptoHasher("sha256").update(`${packageHash}:${lockHash}`).digest("hex") } });
    const actionCeilingSat = (2n * BigInt(maximumOperationCharge(pricing))).toString();

    priorSource = async (value) => {
      const artifact = await repository.get(value.authorizedPriorArtifactReference);
      if (!artifact || artifact.accountId !== value.accountId || artifact.sessionId !== value.sessionId) return undefined;
      const source = (await app.pool.query<{ proposal_json: { files?: unknown } }>("SELECT proposal_json FROM source_proposals WHERE proposal_sha256=$1 AND account_id=$2 AND session_id=$3 AND action_id=$4", [artifact.proposalSha256, value.accountId, value.sessionId, artifact.actionId])).rows[0]?.proposal_json;
      const files = source && typeof source === "object" && Array.isArray((source as { files?: unknown }).files) ? (source as { files: unknown[] }).files : undefined;
      if (!files) return undefined;
      const parsed = files.filter((file): file is { path: "src/main.ts" | "src/styles.css" | "src/capabilities.json"; content: string } => typeof file === "object" && file !== null && ["src/main.ts", "src/styles.css", "src/capabilities.json"].includes(String((file as { path?: unknown }).path)) && typeof (file as { content?: unknown }).content === "string");
      return parsed.length === files.length ? parsed : undefined;
    };

    // Sandboxed preview in the pinned Paja runtime, served only on the preview origin.
    const paja = await import("../../tests/dev-ui/node_modules/@kehto/paja");
    const previewServer = await createPreviewServer({ publicOrigin: config.origins.preview, repository, grants, paja: { startPajaServer: paja.startPajaServer, domains: paja.PAJA_SIMULATION_DOMAINS } });
    closers.push(() => previewServer.close());
    // Publication manifests are signed by the user's own Nostr signer in the
    // browser; the service signs only its own preview-copy events.
    const publication = await LocalPublication.open({ pubkey: servicePubkey, sign: async (template) => finalizeEvent(template, Uint8Array.from(Buffer.from(identity.signerPrivateKey, "hex"))), publicOrigin: config.origins.blobs, publicRelay: config.origins.relay, pool: app.pool, repository, root: resolve(storage, "published"), workerResultsRoot: resolve(storage, "worker-results"), relay: config.relay.url, openTarget: (target) => previewServer.openTarget(target) });
    closers.push(() => publication.close());

    const preview = {
      async previewVerifiedArtifact(value: Readonly<{ accountId: string; sessionId: string; artifactId: string }>) {
        progress.emit("preview", "running");
        const artifact = await repository.get(value.artifactId);
        if (!artifact || artifact.accountId !== value.accountId || artifact.sessionId !== value.sessionId) return { state: "denied" as const, nextAction: "preview" as const, safeReasonCode: "preview_not_available" as const };
        const grant = await grants.create({ ownerId: artifact.ownerId, accountId: artifact.accountId, sessionId: artifact.sessionId, artifact });
        const previewUrl = await previewServer.openPaja(grant.token);
        progress.emit("preview", "completed");
        return { state: "ready" as const, artifactId: artifact.artifactId, aggregateSha256: artifact.aggregateSha256, previewGrantId: grant.previewGrantId, expiresAtMs: grant.expiresAtMs, previewUrl, nextAction: "review_capabilities" as const };
      },
      async reviewCapabilities(value: Readonly<{ accountId: string; sessionId: string; artifactId: string }>) {
        const artifact = await repository.get(value.artifactId);
        return artifact && artifact.accountId === value.accountId && artifact.sessionId === value.sessionId ? { state: "ready" as const, artifactId: artifact.artifactId, aggregateSha256: artifact.aggregateSha256, capabilityDigest: artifact.verificationEvidenceSha256, runtimeVariant: "paja-0.19.0", required: [], optional: [], nextAction: "sign_manifest" as const } : { state: "denied" as const, nextAction: "preview" as const, safeReasonCode: "preview_not_available" as const };
      },
    };
    async function shareVerified(result: SessionActionResult): Promise<SessionActionResult> {
      if (result.status === "completed" && result.artifactId) {
        progress.emit("cvm_share", "running");
        try { const artifact = await repository.get(result.artifactId); const shared = artifact ? await publication.ensurePreview(artifact) as { status: string } : undefined; progress.emit("cvm_share", shared?.status === "published" ? "completed" : "uncertain"); }
        catch { progress.emit("cvm_share", "uncertain"); }
      }
      return result;
    }
    const projects = new DevelopmentProjects(app.pool, new ProjectRevisions(app.pool, repository));
    const interrupted = new InterruptedDevelopmentGeneration(app.pool, app.database.meteredFunding);
    async function recoverInterrupted(result: SessionActionResult): Promise<SessionActionResult> {
      if (result.status !== "usage_unknown") return result;
      await interrupted.recover(result.accountId, result.sessionId);
      const action = await app.database.meteredFunding.findMeteredActionByOperation(result.accountId, result.operationId);
      return action?.result ? SessionActionResultSchema.parse(action.result) : result;
    }
    const bind = async (pubkey: string) => { await projects.bind(pubkey); owners.set(await accountIdForPrincipal({ pubkey }), pubkey); };
    const generationFacade = {
      async startSession(value: any) {
        await bind(value.principal.pubkey);
        const result = await shareVerified(await recoverInterrupted(await generation.startSession(value)));
        if ("sessionId" in result) await projects.name(value.principal.pubkey, result.sessionId, value.idea).catch(() => undefined);
        return result;
      },
      async reviseSession(value: any) { await bind(value.principal.pubkey); return shareVerified(await recoverInterrupted(await generation.reviseSession(value))); },
    };
    const preAdmissionFacade = {
      async saveStart(value: any) {
        await projects.bind(value.owner.ownerId);
        const result = await preAdmission.saveStart(value);
        return result.status === "saved" ? { ...result, nextAction: "funded_admission" as const } : result;
      },
      async status(value: any) {
        const record = await preAdmission.status(value);
        if (!record) return { status: "not_found_or_denied" as const };
        const balance = await app.database.funding.status(record.accountId);
        const base = { checkpointId: record.checkpointId, reference: record.reference, fingerprint: record.commandFingerprint, maximum: record.maximum, version: 1 as const, expiresAtMs: record.expiresAtMs };
        if (record.state === "saved") return { status: "saved" as const, ...base, shortfall: (BigInt(record.maximum) > BigInt(balance?.available ?? "0") ? BigInt(record.maximum) - BigInt(balance?.available ?? "0") : 0n).toString(), nextAction: "funded_admission" as const };
        if (record.state === "bound") return { status: "bound" as const, ...base, nextAction: "wait_for_current_action" as const };
        return { status: record.state, ...base, nextAction: record.state === "completed" ? "revise_session" as const : "retry_resume" as const };
      },
      async resume(value: any) {
        await projects.bind(value.owner.ownerId);
        owners.set(value.owner.accountId, value.owner.ownerId);
        return shareVerified(await recoverInterrupted(await preAdmission.resume(value)));
      },
    };
    new ContextVmFundingAdapter({
      publicPreviewOrigin: config.origins.preview, service: app.funding, transport: progress, admissions: fundedAdmission, admissionReceipts: receipts, accountStatus,
      topUps: { lightning: app.lightning, cashu: app.cashu }, generation: generationFacade, preAdmission: preAdmissionFacade,
      sessionStatus: { read: async (query: any) => {
        const accountId = await accountIdForPrincipal(query.principal);
        await interrupted.recover(accountId, query.sessionId);
        const result = await readSessionStatus({ store: app.database.meteredFunding, query, cursorSecret: identity.cursorSecret });
        if (result.status !== "ok") return result;
        return { ...result, session: { ...result.session, timeline: await durableTimeline(app, accountId, query.sessionId) } };
      } },
      preview,
      extensions: {
        projects: (value, pubkey) => projects.handle(value, pubkey),
        development_publication: (value, pubkey) => publication.handle(value, pubkey),
        service_info: async (value, pubkey) => {
          ServiceInfoArgumentsSchema.parse(value);
          return { reserveSat: config.funding.reserveSat, actionCeilingSat, providerLabel: config.model.adapter === "deterministic-test" ? "Deterministic test model · test credits" : config.realm === "real" ? "OpenAI Responses · metered sats" : "OpenAI Responses · test credits", estimates: await readGenerationEstimates(app.pool, pubkey, pricing, actionCeilingSat).catch(() => null), available: true, development: false, realm: config.realm };
        },
      },
      policyVersion: config.policy.version,
    });

    const reconciler = new DevelopmentNwcSettlementReconciler(app, 2_000);
    closers.push(() => reconciler.stop());
    const assets = await buildStaticWorkspace({ relayUrl: config.origins.relay, servicePubkey });
    await transport.start();
    closers.push(() => Promise.race([transport.close().catch(() => undefined), Bun.sleep(1_000)]));
    reconciler.start();

    const publicHost = new URL(config.origins.public).host;
    const previewHost = new URL(config.origins.preview).host;
    const blobsHost = new URL(config.origins.blobs).host;
    const relayPath = new URL(config.origins.relay).host === publicHost ? new URL(config.origins.relay).pathname : undefined;
    type Peer = { upstream?: WebSocket; pending: Array<string | Buffer> };
    const securityHeaders = { "cache-control": "no-cache", "referrer-policy": "no-referrer", "content-security-policy": "frame-ancestors 'none'; base-uri 'none'; object-src 'none'", "x-frame-options": "DENY", "x-content-type-options": "nosniff" };
    const web = Bun.serve<Peer>({
      hostname: input.hostname ?? "0.0.0.0",
      port: config.listen.port,
      async fetch(request, server) {
        const url = new URL(request.url);
        // The reverse proxy forwards the original Host; each origin has a fixed role.
        const host = request.headers.get("host") ?? url.host;
        if (url.pathname === "/health") return Response.json({ status: "ok", realm: config.realm });
        if (host === previewHost) return (await previewServer.handlePublic(request)) ?? new Response("not found", { status: 404 });
        if (host === blobsHost) {
          const headers = new Headers(request.headers); headers.delete("host"); headers.delete("connection");
          try { return await fetch(new URL(url.pathname + url.search, publication.localOrigin), { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body, redirect: "manual", signal: AbortSignal.timeout(60_000) }); }
          catch { return new Response("unavailable", { status: 502 }); }
        }
        if (host !== publicHost) return new Response("not found", { status: 404 });
        if (relayPath && url.pathname === relayPath && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          if (server.upgrade(request, { data: { pending: [] } })) return;
          return new Response("upgrade failed", { status: 400 });
        }
        if (request.method === "GET" || request.method === "HEAD") {
          const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
          const asset = !name.startsWith("admin.") && name !== "console.html" ? assets.get(name) : undefined;
          if (asset !== undefined) {
            const type = name.endsWith(".html") ? "text/html" : name.endsWith(".css") ? "text/css" : name.endsWith(".json") ? "application/json" : "text/javascript";
            return new Response(request.method === "HEAD" ? null : asset, { headers: { "content-type": `${type}; charset=utf-8`, ...securityHeaders } });
          }
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(socket) {
          const upstream = new WebSocket(config.relay.url); socket.data.upstream = upstream;
          upstream.onopen = () => { for (const message of socket.data.pending) upstream.send(message as string); socket.data.pending.length = 0; };
          upstream.onmessage = (event) => socket.send(typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer));
          upstream.onclose = () => socket.close(); upstream.onerror = () => socket.close(1011, "relay unavailable");
        },
        message(socket, message) {
          if (socket.data.upstream?.readyState === WebSocket.OPEN) socket.data.upstream.send(message as string);
          else if (socket.data.pending.length < 32) socket.data.pending.push(message);
          else socket.close(1009, "relay starting");
        },
        close(socket) { socket.data.upstream?.close(); },
        maxPayloadLength: 2_000_000,
      },
    });
    closers.push(() => web.stop(true));
    return Object.freeze({
      url: `http://127.0.0.1:${web.port}`,
      servicePubkey,
      realm: config.realm,
      async status() {
        await assertCanonicalSchema(pool);
        await assertServiceRealm(pool, config.realm);
        return Object.freeze({ realm: config.realm, servicePubkey, workerImage: readiness.imageDigest, workerRuntime: config.worker.runtime, model: configured?.model ?? "deterministic-test", migrations: "current" as const });
      },
      close,
    });
  } catch (error) {
    await close();
    throw error;
  }
}
