import { fundedReplayAuthorityFixture } from "../fixtures/funded-replay-authority";
import { computeCanonicalInvocationIdentity } from "@contextvm/sdk/payments/canonical-identity";
import { createDurableContextVmTransport, openContextVmRelayTransport } from "../../src/release/deployment/contextvm-client";
import { ProductionContextVmGenerationIntakes } from "../../src/production/contextvm-generation-intake";
import { ContextVmFundingAdapter } from "../../src/contextvm/adapter";
import type { ContextVmTransportPort, ContextVmInboundEnvelope, ContextVmWireResponse } from "../../src/contextvm/sdk-bridge";
import { ProductionWorkerOwnershipResolver } from "../../src/production/worker-bridge";
import { ProtectedGenerationCommands, RetainedGenerationCommandSchema } from "../../src/model/retained-generation-command";
import { ProductionGenerationRecovery } from "../../src/production/generation-recovery";
import { loadMountedCheckpointKek } from "../../src/production/checkpoint-crypto";
import { delayedResponse } from "../fixtures/model/delayed-response";
import { expect, test } from "bun:test";
import { z } from "zod";
import { Pool } from "pg";
import { createVertexGeminiProductionPricing } from "../../src/model/price-card";
import { registerProductionPricing } from "../../src/production/pricing-catalog";
import { FundingService } from "../../src/funding/funding-service";
import { FundedAdmissionService } from "../../src/funding/funded-admission";
import { ContinuationService } from "../../src/continuity/continuation-service";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";
import type { PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";
import { MeteredGenerationService, StartSessionCommandSchema, type SessionActionResult } from "../../src/phase-04/metered-generation-service";
import { ProductionSourceProposalStore, assertProductionSourceProposalSchema } from "../../src/production/source-proposal-store";
import { ProductionVertexModelGateway } from "../../src/production/vertex-model-gateway";
import { createProductionVertexGenerationSettlement } from "../../src/production/vertex-generation-settlement";
import { createVertexDeploymentClient, createVertexInteractionsHttpPort } from "../../src/release/deployment/vertex-client";
import { PostgresOperationJournal } from "../../src/release/deployment/postgres-operation-journal";
import { createPostgresVertexOperationJournal } from "../../src/release/deployment/postgres-provider-journals";
import { ProviderOperationIntentSchema } from "../../src/model/model-gateway";
import type { ArtifactVerifier } from "../../src/phase-02/trusted-core";
import type { WorkerPort } from "../../src/phase-02/contracts";
import { exactReadyReservation, trustedAdmissionReceipt, trustedAdmissionReceiptAuthority } from "../fixtures/admission-ready";
const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
const now = Date.now();
async function docker(args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`DOCKER_FAILED:${args[0]}:${err.slice(0, 300)}`);
  return out.trim();
}
type PrepareFault = { commit?: "before" | "after"; intakeAckLost?: boolean };
function restrictedPool(native: Pool, fault: PrepareFault = {}): PostgresSqlPool {
  return { async connect() {
    const connectingAt = performance.now();
    const client = await native.connect();
    let archiveInserted = false, intakeInserted = false;
    if (performance.now() - connectingAt >= 200) console.error("MODEL_COMPOSITION_SLOW_POOL_CONNECT", Math.round(performance.now() - connectingAt));
    return { async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      if (sql.startsWith("INSERT INTO production_real.generation_recovery_commands")) archiveInserted = true;
      if (sql.startsWith("INSERT INTO production_real.release_operation_journal") && String(values?.[2]).startsWith("contextvm-intake:")) intakeInserted = true;
      const commitFault = sql === "COMMIT" && archiveInserted ? fault.commit : undefined;
      if (commitFault) delete fault.commit;
      if (commitFault === "before") throw new Error("FIXTURE_PREPARE_ROLLBACK");
      const startedAt = performance.now();
      try {
        const result = await client.query<Row>(sql, values ? [...values] : undefined);
        if (commitFault === "after") throw new Error("FIXTURE_PREPARE_COMMIT_ACK_LOST");
        if (sql === "COMMIT" && intakeInserted && fault.intakeAckLost) { delete fault.intakeAckLost; throw new Error("FIXTURE_INTAKE_COMMIT_ACK_LOST"); }
        return { rows: result.rows };
      } finally {
        // Static SQL only: never print account, prompt, credential or parameter values.
        const elapsedMs = performance.now() - startedAt;
        if (elapsedMs >= 200) console.error("MODEL_COMPOSITION_SLOW_SQL", Math.round(elapsedMs), sql);
      }
    }, release() { client.release(); } };
  } };
}

integration.each(["legacy-completed", "current-missing-counter", "delayed-current", "retained-restart", "retained-rollback", "retained-commit-ack", "retained-concurrent", "retained-restored", "retained-expired", "retained-lease-reclaim", "retained-intake-before-handler", "retained-intake-lost-commit-ack", "retained-intake-expired-worker"])("normal paid graph preserves real operation IDs, source and exact cached settlement (%s)", async (wireCase) => {
  const name = `cvm-model-composition-${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: Pool | undefined, native: Pool | undefined;
  try {
    await docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
    const port = (await docker(["port", name, "5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 90; attempt++) {
      try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 89) throw error; await Bun.sleep(250); }
    }
    for (const file of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-07/001_production_operation_journal.sql", "phase-07/002_production_pricing_catalog.sql", "phase-07/003_production_checkpoints.sql", "phase-07/008_production_account_owners.sql", "phase-07/009_production_resume_pricing_quotes.sql", "phase-07/010_production_priced_continuations.sql", "phase-07/011_production_priced_continuation_workers.sql", "phase-07/012_production_priced_continuation_restores.sql"]) await admin.query(await Bun.file(`migrations/${file}`).text());
    await admin.query("CREATE ROLE funded_generation_test LOGIN");
    await admin.query("GRANT napplet_production_real TO funded_generation_test");
    native = new Pool({ connectionString: `postgresql://funded_generation_test@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    const retained = wireCase.startsWith("retained-");
    const prepareFault: PrepareFault = {};
    let currentNative = native;
    const pool: PostgresSqlPool = { connect: () => restrictedPool(currentNative,prepareFault).connect() };
    const database = new PostgresFundingDatabase(pool, { realm: "production-real" });
    const pricing = await createVertexGeminiProductionPricing({
      observation: { sourceUrl: "https://cloud.google.com/vertex-ai/generative-ai/pricing", bytes: new TextEncoder().encode("explicit composed model pricing fixture"), observedAtMs: now, freshUntilMs: now + 60_000, currency: "USD", location: "global", model: "gemini-4-argon", inputMicrosPerMillion: 4_000_000, cachedInputMicrosPerMillion: 200_000, outputAndThoughtMicrosPerMillion: 20_000_000 },
      conversion: { source: { url: "https://blockchain.info/ticker", capturedBytesSha256: "e".repeat(64), observedAt: new Date(now).toISOString(), effectiveAt: new Date(now).toISOString(), freshUntil: new Date(now + 60_000).toISOString() }, satsPerUsd: { numerator: "1000", denominator: "1" } },
      profileId: "composed-model-fixture", maximumInputTokens: "2000", maximumOutputTokens: "100", deadlineMs: 30_000,
    });
    await registerProductionPricing({ pool, ...pricing });
    if (retained) {
      const recoveryMigration = await Bun.file("migrations/phase-07/007_production_generation_recovery.sql").text();
      await admin.query(recoveryMigration); await admin.query(recoveryMigration);
    }
    const commands = new ProtectedGenerationCommands({ reference: "test:checkpoint-kek", load: () => loadMountedCheckpointKek({ kekPath: "/test/kek", readFile: async () => Buffer.alloc(32,9).toString("base64") }) }, wireCase === "retained-expired" ? () => Date.now()-30*86_400_000+1500 : Date.now);
    let posts = 0, builds = 0, reads = 0;
    let storedCurrent: unknown;
    await expect(assertProductionSourceProposalSchema(pool)).rejects.toThrow("PRODUCTION_SOURCE_PROPOSAL_SCHEMA_REQUIRED");
    expect(posts).toBe(0);
    const migration = await Bun.file("migrations/phase-07/004_production_source_proposals.sql").text();
    await admin.query(migration); await admin.query(migration);
    await assertProductionSourceProposalSchema(pool);
    const sources = new ProductionSourceProposalStore(pool);
    const journal = new PostgresOperationJournal(pool, { namespace: "composed-model", scopeSha256: "a".repeat(64) });
    const interactions = createVertexInteractionsHttpPort({ timeoutMs: 1000, creationTimeoutMs: 2500, accessToken: async () => "test-only-token-aaaaaaaaaaaaaaaaaaaa", fetch: Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "GET") {
        reads++;
        if (!storedCurrent) throw new Error("ORIGINAL_INTERACTION_REQUIRED");
        return String(_url).includes("page_size=") ? Response.json({ interaction_metadatas: [{ id: "composed-original" }] }) : Response.json(storedCurrent);
      }
      if (init?.method !== "POST") throw new Error("ONLY_ORIGINAL_POST_EXPECTED");
      posts++;
      const wire = z.object({ input: z.array(z.unknown()), system_instruction: z.string(), generation_config: z.object({ max_output_tokens: z.literal(200) }).passthrough() }).passthrough().parse(JSON.parse(String(init.body)));
      const content = [{ type: "text", text: JSON.stringify({ files: [{ path: "src/main.ts", content: "document.body.textContent = 'One timer';" }] }) }];
      if (wireCase === "legacy-completed") return Response.json({ id: "composed-original", model: "gemini-4-argon", input: wire.input, status: "completed", created: new Date(now).toISOString(), steps: [{ model_output: { content } }], usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100, thought_tokens: 0, tool_use_tokens: 0 } });
      const currentUsage = { total_input_tokens: 1000, total_cached_tokens: 200, total_output_tokens: 100, total_thought_tokens: 0, total_tool_use_tokens: 0, total_tokens: 1100 };
      storedCurrent = { id: "composed-original", model: "gemini-4-argon", status: "completed", created: new Date(now).toISOString(), steps: [{ type: "user_input", content: wire.input }, { type: "model_output", content }], usage: currentUsage };
      if (wireCase === "delayed-current") return delayedResponse(1200, init.signal, Response.json({ id: "composed-original", model: "gemini-4-argon", status: "completed", created: new Date(now).toISOString(), steps: [{ type: "model_output", content }], usage: currentUsage }));
      return Response.json({ id: "composed-original", model: "gemini-4-argon", status: "completed", created: new Date(now).toISOString(), steps: [{ type: "model_output", content }], usage: { ...currentUsage, total_cached_tokens: undefined } });
    }, { preconnect() {} }) });
    const vertex = createVertexDeploymentClient({ candidateSha256: "b".repeat(64), projectId: "napplet-cvm-test", location: "global", model: "gemini-4-argon", credentialReference: "gcp:adc:test", price: { sourceUrl: "https://cloud.google.com/vertex-ai/generative-ai/pricing", sourceDocumentSha256: pricing.card.sources!.provider.capturedBytesSha256, quoteSha256: "c".repeat(64), observedAtMs: now, freshUntilMs: now + 60_000, effectiveFromMs: now, effectiveUntilMs: now + 60_000, currency: "USD", inputMicrosPerMillion: 4_000_000, cachedInputMicrosPerMillion: 200_000, outputAndThoughtMicrosPerMillion: 20_000_000 }, journal: createPostgresVertexOperationJournal(journal), interactions, now: () => now });
    const gateway = new ProductionVertexModelGateway({ vertex, proposals: sources });
    const settlement = createProductionVertexGenerationSettlement({ gateway, conversion: pricing.conversion, journal });
    const principal = { pubkey: "9".repeat(64) }, funding = new FundingService(database.funding);
    // Local credit, HTTP and worker protocol fixtures: production classes run,
    // but no real funding, model API, isolated build or release suite is claimed.
    await funding.execute({ principal, kind: "credit_settlement", idempotencyKey: "seed-credit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { settlement: { topUpId: "seed-topup", rail: "lightning", unit: "sat", amount: "3250", externalReference: "seed-external", settlementReference: "seed-settlement", verifiedAt: new Date(now).toISOString() } } });
    const capacity = { async reserveNow(value: { intentReference: string }) { return exactReadyReservation(value.intentReference, `capacity:${value.intentReference.split(":")[1]}`, new Date(now + 1_200_000).toISOString()); }, async observe(value: { intentReference: string }) { return this.reserveNow(value); }, async release() {} };
    const admissions = new FundedAdmissionService({ funding, store: database.funding, capacity, receiptAuthority: trustedAdmissionReceiptAuthority, now: () => now });
    const admissionCommand = { principal, idempotencyKey: "admit", policyVersion: "funding-policy-v1", protocolVersion: "funding-contract-v1", payload: { requestedCap: "3250", unit: "sat" } };
    const admission = await admissions.admit(admissionCommand, await trustedAdmissionReceipt(admissionCommand));
    if (admission.status !== "accepted") throw new Error("FIXTURE_ADMISSION_REQUIRED");
    let replayNow=Date.now();
    const replay = await fundedReplayAuthorityFixture({pool,principal,admissionReference:admission.reference,now:()=>replayNow});
    const worker: WorkerPort = { async run(request) { expect(await new ProductionWorkerOwnershipResolver({pool,policyVersion:request.policyVersion}).resolve(request)).toEqual({accountId:admission.accountId,ownerId:principal.pubkey}); builds++; return { status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [{ kind: "progress", turn: 1, detail: "explicit protocol fixture completed" }], artifact: { sessionId: request.sessionId, actionId: request.actionId, expectedVersion: request.expectedVersion, policyVersion: request.policyVersion, capabilityGrant: request.capabilityGrant, workspaceId: request.workspaceId, artifactId: "fixture:artifact", purpose: { kind: "focused", statements: ["one counter"] }, surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false }, dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false }, capabilities: { declaredHard: [], observedDomains: [], optionalIntentPresenceRead: false, intentUsedThroughSdk: false }, upstream: { scanner: { verdict: "pass", checkId: "upstream:fixture-scanner" }, conformance: { verdict: "pass", checkId: "upstream:fixture-browser" } } } }; } };
    const verifier: ArtifactVerifier = { async verify(facts) { if (facts.result.status !== "completed") return undefined; return { artifact: { artifactId: facts.result.artifact.artifactId, artifactSha256: "a".repeat(64), scannerReportSha256: "b".repeat(64), conformanceReportSha256: "c".repeat(64) }, contractInput: facts.result.artifact }; } };
    const open = () => new MeteredGenerationService({ ...(retained ? { recoveryCommands: commands } : {}), fundedAdmission: admissions, store: database.meteredFunding, gateway, worker, artifactVerifier: verifier, proposalStore: sources, pricing, settlement, continuation: new ContinuationService({ store: database.funding, includeAdmissionHold: true }), toolchainIdentity: "b".repeat(64), clock: { nowMs: () => now } });
    const command = StartSessionCommandSchema.parse({ principal, admissionReference: admission.reference, idempotencyKey: "start", expectedVersion: 0, maximum: "3250", policyVersion: "funding-policy-v1", idea: "One focused timer." });
    let recoveredInitial: SessionActionResult | undefined;
    if(wireCase.startsWith("retained-intake-")){
      let intakeNow=Date.now();
      const intakeJournal=new PostgresOperationJournal(pool,{namespace:"composed-contextvm",scopeSha256:"a".repeat(64)});
      const responses:ContextVmWireResponse[]=[];
      const envelope:ContextVmInboundEnvelope={verifiedClientPubkey:principal.pubkey,requestEventId:"f".repeat(64),rawEvent:{id:"f".repeat(64),tags:[]},request:{id:1,method:"tools/call",params:{name:"start_session",arguments:{admissionReference:command.admissionReference,idempotencyKey:command.idempotencyKey,maximum:command.maximum,idea:command.idea}}}};
      function controller(context="c".repeat(64),crash=false){
        let inbound:((v:ContextVmInboundEnvelope)=>Promise<void>)|undefined;
        const source:ContextVmTransportPort={onInbound(h){inbound=h;},configureAnnouncement(){},async sendResponse(_owner,response){responses.push(response);},async sendNotification(){},canonicalInvocation(clientPubkey,method,params){return computeCanonicalInvocationIdentity(clientPubkey,method,params);}};
        const intakes=new ProductionContextVmGenerationIntakes({journal:intakeJournal,executionContextSha256:context,replayAuthority:replay.authority,key:{reference:"test:checkpoint-kek",load:()=>loadMountedCheckpointKek({kekPath:"/test/kek",readFile:async()=>Buffer.alloc(32,9).toString("base64")})},now:()=>intakeNow});
        const transport=createDurableContextVmTransport({source,journal:intakeJournal,relaySetSha256:"a".repeat(64),generationIntakes:intakes});
        const core=open();
        new ContextVmFundingAdapter({service:funding,transport,generation:{async startSession(input){recoveredInitial=await core.startSession(input);return recoveredInitial;},reviseSession:input=>core.reviseSession(input)}});
        if(crash)transport.onInbound(async()=>{throw new Error("FIXTURE_CONTROLLER_LOSS_BEFORE_ADAPTER");});
        return {transport,intakes,async deliver(value=envelope){if(!inbound)throw new Error("INBOUND_REQUIRED");await inbound(value);}};
      }
      const lostAck = wireCase === "retained-intake-lost-commit-ack";
      if (lostAck) prepareFault.intakeAckLost = true;
      await expect(controller(undefined,!lostAck).deliver()).rejects.toThrow(lostAck ? "FIXTURE_INTAKE_COMMIT_ACK_LOST" : "FIXTURE_CONTROLLER_LOSS_BEFORE_ADAPTER");
      expect({posts,builds}).toEqual({posts:0,builds:0});
      expect((await admin.query("SELECT count(*)::int AS n FROM production_real.metered_actions")).rows[0].n).toBe(0);
      const original=await intakeJournal.read(envelope.requestEventId);
      expect(original?.value).toEqual({state:"pending"});
      const protectedRecord=await intakeJournal.read(`contextvm-intake:${envelope.requestEventId}`);
      expect(JSON.stringify(protectedRecord)).not.toContain(command.idea);
      expect(protectedRecord?.value).toMatchObject({schemaVersion:"protected-contextvm-generation-intake-v1",state:"pending"});
      if(wireCase==="retained-intake-expired-worker"){
        intakeNow+=1_200_001;replayNow=intakeNow;
        expect(await controller().transport.recoverPendingGenerations()).toBe(1);
        expect({posts,builds}).toEqual({posts:0,builds:0});
        expect((await admin.query("SELECT count(*)::int AS n FROM production_real.metered_actions")).rows[0].n).toBe(0);
        expect((await intakeJournal.read(envelope.requestEventId))?.value).toEqual({state:"pending"});
        return;
      }
      intakeNow+=61_000;replayNow=intakeNow;
      expect(await controller("d".repeat(64)).transport.recoverPendingGenerations()).toBe(1);
      expect({posts,builds}).toEqual({posts:0,builds:0});
      intakeNow+=31_000;replayNow=intakeNow;
      replay.setMissing(true);
      expect(await controller().transport.recoverPendingGenerations()).toBe(1);
      expect({posts,builds}).toEqual({posts:0,builds:0});
      replay.setMissing(false);intakeNow+=31_000;replayNow=intakeNow;
      const resumed=controller();
      // Official SDK, never started: a fresh server has no in-memory client
      // session. Notification delivery must not replace the recovered result.
      const nativeRelay=await openContextVmRelayTransport({serviceKeyReference:"test:service",relaySetSha256:"a".repeat(64),relays:["wss://relay.invalid"],journal:intakeJournal,generationIntakes:resumed.intakes,signerBroker:{async resolveContextVmSigner(){return {async getPublicKey(){return "a".repeat(64);},async signEvent(){throw new Error("FIXTURE_MUST_NOT_SIGN_OR_CONNECT");}};}}});
      const nativeCore=open();
      new ContextVmFundingAdapter({service:funding,transport:nativeRelay.transport,generation:{async startSession(input){recoveredInitial=await nativeCore.startSession(input);return recoveredInitial;},reviseSession:input=>nativeCore.reviseSession(input)}});
      try{expect(await nativeRelay.transport.recoverPendingGenerations()).toBe(1);}finally{await nativeRelay.close();}
      expect((await intakeJournal.read(envelope.requestEventId))?.value).toMatchObject({state:"completed",response:{result:{status:"usage_unknown"}}});
      expect(recoveredInitial?.status).toBe("usage_unknown");
      expect({posts,builds}).toEqual({posts:1,builds:0});
      expect((await intakeJournal.read(`contextvm-intake:${envelope.requestEventId}`))?.value).toMatchObject({state:"erased"});
      expect(JSON.stringify((await intakeJournal.read(`contextvm-intake:${envelope.requestEventId}`))?.value)).not.toContain("wrappedDekBase64");
      const cached=z.object({response:z.object({jsonrpc:z.literal("2.0"),id:z.union([z.string(),z.number(),z.null()]),result:z.unknown().optional(),error:z.object({code:z.number(),message:z.string()}).optional()})}).passthrough().parse((await intakeJournal.read(envelope.requestEventId))?.value).response;
      await controller().deliver();expect(responses.at(-1)).toEqual(cached);
      expect({posts,builds}).toEqual({posts:1,builds:0});
    }
    if (wireCase === "retained-rollback" || wireCase === "retained-commit-ack") {
      prepareFault.commit = wireCase === "retained-rollback" ? "before" : "after";
      await expect(open().startSession(command)).rejects.toThrow(wireCase === "retained-rollback" ? "FIXTURE_PREPARE_ROLLBACK" : "FIXTURE_PREPARE_COMMIT_ACK_LOST");
      const count = wireCase === "retained-rollback" ? 0 : 1;
      expect((await admin.query("SELECT count(*)::int AS n FROM production_real.generation_recovery_commands")).rows[0].n).toBe(count);
      expect((await admin.query("SELECT count(*)::int AS n FROM production_real.metered_actions")).rows[0].n).toBe(count);
      expect((await admin.query("SELECT count(*)::int AS n FROM production_real.action_budget_reservations")).rows[0].n).toBe(count);
      expect({ posts, builds }).toEqual({ posts: 0, builds: 0 });
      if (count === 1) {
        replay.setMissing(true);
        await admin.query("UPDATE production_real.generation_recovery_commands SET next_attempt_at=clock_timestamp()-interval '1 second'");
        expect(await new ProductionGenerationRecovery({pool,commands,replayAuthority:replay.authority,acceptedToolchains:["b".repeat(64)],generation:open()}).scan()).toEqual({attempted:1,erased:0});
        expect({posts,builds}).toEqual({posts:0,builds:0});
        replay.setMissing(false);
        await admin.query("UPDATE production_real.generation_recovery_commands SET next_attempt_at=clock_timestamp()-interval '1 second'");
        expect(await new ProductionGenerationRecovery({ pool, commands, replayAuthority: replay.authority, acceptedToolchains: ["b".repeat(64)], generation: { async recoverRecordedAction(input) { recoveredInitial = await open().recoverRecordedAction(input); return recoveredInitial; } } }).scan()).toEqual({ attempted: 1, erased: 0 });
        expect({ posts, builds }).toEqual({ posts: 1, builds: 0 });
      }
    }
    let result = recoveredInitial ?? await open().startSession(command);
    if ((wireCase === "current-missing-counter" || retained)) {
      expect(result.status).toBe("usage_unknown");
      if (result.status !== "usage_unknown") throw new Error("UNPROVEN_USAGE_MUST_WAIT");
      expect({ posts, builds }).toEqual({ posts: 1, builds: 0 });
      expect((await admin.query("SELECT count(*)::int AS count FROM production_real.ledger_entries WHERE account_id=$1 AND direction='debit'", [result.accountId])).rows[0].count).toBe(0);
      if (wireCase === "retained-expired") {
        await Bun.sleep(1600);
        expect(await new ProductionGenerationRecovery({ pool,commands,replayAuthority:replay.authority,acceptedToolchains:["b".repeat(64)],generation:open() }).scan()).toEqual({attempted:0,erased:1});
        expect((await admin.query("SELECT state,envelope_json FROM production_real.generation_recovery_commands")).rows[0]).toEqual({state:"erased",envelope_json:null});
        expect({posts,builds}).toEqual({posts:1,builds:0});
        expect((await admin.query("SELECT count(*)::int AS n FROM production_real.ledger_entries WHERE direction='debit' AND account_id=$1",[result.accountId])).rows[0].n).toBe(0);
        return;
      }
      if (wireCase === "retained-restored") {
        const globals = (await docker(["exec",name,"pg_dumpall","-U","postgres","--roles-only"])).replace(/^CREATE ROLE postgres;$/mu,"");
        const dump = await docker(["exec",name,"pg_dump","-U","postgres","--schema=production_real","--no-owner","postgres"]);
        await docker(["run","--detach","--rm","--name",`${name}-restore`,"--publish","127.0.0.1::5432","-e","POSTGRES_HOST_AUTH_METHOD=trust","postgres:17-alpine"]);
        const restoredPort = (await docker(["port",`${name}-restore`,"5432/tcp"])).match(/127\.0\.0\.1:(\d+)/u)?.[1];
        if (!restoredPort) throw new Error("RESTORE_PORT_REQUIRED");
        const restoredAdmin = new Pool({connectionString:`postgresql://postgres@127.0.0.1:${restoredPort}/postgres`});
        for(let i=0;i<90;i++){try{await restoredAdmin.query("SELECT 1");break;}catch(error){if(i===89)throw error;await Bun.sleep(250);}}
        const restore = Bun.spawn(["docker","exec","-i",`${name}-restore`,"psql","-U","postgres","--set","ON_ERROR_STOP=1","postgres"],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
        restore.stdin.write(`${globals}\n${dump}\n`);restore.stdin.end();
        const [code,,err] = await Promise.all([restore.exited,new Response(restore.stdout).text(),new Response(restore.stderr).text()]);
        if(code)throw new Error(`LOCAL_RESTORE_FAILED:${err.slice(0,300)}`);
        await native.end();await admin.end();
        admin=restoredAdmin;
        native=new Pool({connectionString:`postgresql://funded_generation_test@127.0.0.1:${restoredPort}/postgres`});
        currentNative=native;
        expect((await admin.query("SELECT count(*)::int AS n FROM production_real.generation_recovery_commands WHERE envelope_json IS NOT NULL")).rows[0].n).toBe(1);
      }
      if (retained) {
        const saved = RetainedGenerationCommandSchema.parse((await admin.query("SELECT binding_json AS binding,envelope_json AS envelope FROM production_real.generation_recovery_commands")).rows[0]);
        expect(JSON.stringify(saved)).not.toContain(command.idea);
        expect(await commands.open(saved)).toEqual(command);
        await expect(commands.open({ ...saved, binding: { ...saved.binding, accountId: `account:${"0".repeat(64)}` } })).rejects.toThrow("GENERATION_COMMAND_RESTORE_DENIED");
        await expect(native.query("UPDATE production_real.generation_recovery_commands SET command_sha256=$1",["f".repeat(64)])).rejects.toThrow("GENERATION_RECOVERY_COMMAND_IMMUTABLE");
        await expect(native.query("UPDATE production_real.generation_recovery_commands SET envelope_json=NULL,state='erased',erased_at=clock_timestamp()")).rejects.toThrow("GENERATION_RECOVERY_ERASURE_NOT_DUE");
        await admin.query("UPDATE production_real.generation_recovery_commands SET next_attempt_at=clock_timestamp()-interval '1 second'");
        const one = new ProductionGenerationRecovery({ pool, commands, replayAuthority: replay.authority, acceptedToolchains: ["b".repeat(64)], generation: open() });
        if (wireCase === "retained-lease-reclaim") {
          await admin.query("UPDATE production_real.generation_recovery_commands SET claim_token='fixture-lost-controller',claim_until=clock_timestamp()+interval '60 seconds'");
          expect(await one.scan()).toEqual({attempted:0,erased:0});
          expect({posts,builds,reads}).toEqual({posts:1,builds:0,reads:0});
          await admin.query("UPDATE production_real.generation_recovery_commands SET claim_until=clock_timestamp()-interval '1 second'");
        }
        await one.assertReady();
        let previouslyErased = 0;
        if (wireCase === "retained-concurrent") {
          const two = new ProductionGenerationRecovery({ pool, commands, replayAuthority: replay.authority, acceptedToolchains: ["b".repeat(64)], generation: open() });
          const outcomes = await Promise.all([one.scan(),two.scan()]);
          expect(outcomes.reduce((sum,item)=>sum+item.attempted,0)).toBe(1);
          previouslyErased = outcomes.reduce((sum,item)=>sum+item.erased,0);
        } else expect(await one.scan()).toEqual({ attempted: 1, erased: 0 });
        expect((await admin.query("SELECT terminal_result FROM production_real.metered_actions WHERE operation_id=$1",[saved.binding.operationId])).rows[0].terminal_result).toMatchObject({status:"completed",confirmedSpend:"6"});
        expect((await one.scan()).erased + previouslyErased).toBe(1);
        const erased = (await admin.query("SELECT state,envelope_json,command_sha256,claim_token FROM production_real.generation_recovery_commands")).rows[0];
        expect(erased).toEqual({state:"erased",envelope_json:null,command_sha256:saved.envelope.commandSha256,claim_token:null});
        await one.close();
      }
      result = await open().startSession(command);
    }
    expect(result).toMatchObject({ status: "completed", confirmedSpend: "6", remainingCap: "3244" });
    if (result.status !== "completed") throw new Error("FIXTURE_COMPLETION_REQUIRED");
    expect(await open().startSession(command)).toEqual(result);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.ledger_entries WHERE account_id=$1 AND direction='debit'", [result.accountId])).rows[0].count).toBe(1);
    expect({ posts, builds }).toEqual({ posts: 1, builds: 1 });
    expect(reads).toBe((wireCase === "current-missing-counter" || retained) ? 3 : 0);
    expect((await admin.query("SELECT count(*)::int AS count FROM production_real.source_proposals")).rows[0].count).toBe(1);
    const action = await database.meteredFunding.findMeteredAction(result.accountId, command.idempotencyKey);
    if (!action) throw new Error("FIXTURE_ACTION_REQUIRED");
    const intent = ProviderOperationIntentSchema.parse({ operationId: action.operationId, providerRequestId: action.operationId, accountId: action.accountId, sessionId: action.sessionId, actionId: action.actionId, expectedVersion: action.expectedVersion, actionBudgetReference: action.actionBudgetReference, profileId: action.profileId, priceCardId: action.priceCardId, requestFingerprint: action.fingerprint, prompt: command.idea, maximumUnits: pricing.profile.maximumUnits, selection: "unselected" });
    const saved = await sources.lookup({ intent });
    if (!saved) throw new Error("FIXTURE_SOURCE_REQUIRED");
    for (const replay of await Promise.all(Array.from({ length: 4 }, () => sources.persist({ intent, provider: "vertex_ai_gemini", model: "gemini-4-argon", proposal: { files: saved.proposal.files } })))) expect(replay.proposal).toEqual(saved.proposal);
    await expect(sources.persist({ intent, provider: "vertex_ai_gemini", model: "gemini-4-argon", proposal: { files: [{ path: "src/main.ts", content: "changed source" }] } })).rejects.toThrow("PRODUCTION_SOURCE_PROPOSAL_CONFLICT");
    expect(await sources.lookup({ intent: { ...intent, accountId: `account:${"0".repeat(64)}` } })).toBeUndefined();
    expect({ posts, builds }).toEqual({ posts: 1, builds: 1 });
    const oversized = { ...command, idempotencyKey: "oversized", idea: Array.from({ length: 10 }, () => "a".repeat(200)).join("\n") };
    const refused = await open().startSession(oversized);
    expect(refused).toMatchObject({ status: "failed", confirmedSpend: "0", remainingCap: "3244" });
    expect(await open().startSession(oversized)).toEqual(refused);
    expect({ posts, builds }).toEqual({ posts: 1, builds: 1 });
    await expect(native.query("UPDATE production_real.source_proposals SET proposal_json='{}'::jsonb")).rejects.toThrow();
    await expect(admin.query("DELETE FROM production_real.source_proposals")).rejects.toThrow("PRODUCTION_SOURCE_PROPOSAL_IMMUTABLE");
  } finally { await native?.end(); await admin?.end(); await docker(["rm", "--force", name]).catch(() => undefined); await docker(["rm","--force",`${name}-restore`]).catch(() => undefined); }
}, 120_000);
