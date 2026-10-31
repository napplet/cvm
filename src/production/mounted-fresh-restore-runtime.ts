import { createMountedProductionWorkerJobRouter } from "./mounted-worker-profiles";
import { z } from "zod";
import type { GcsObjectStoreAdapter } from "../continuity/object-store";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { openProductionServiceJournals } from "./service-journals";
import { createMountedProductionWorkerClients } from "./mounted-worker-clients";
import { createPostgresWorkerOperationJournal } from "../release/deployment/postgres-provider-journals";
import type { DurabilitySubjectSchema, RestoreDrillInputSchema } from "../resilience/fault-harness";
import type { createGoogleDeploymentClients } from "../release/deployment/google-clients";
import type { ProductionConfig } from "./config";
import { ProductionCheckpointCoordinator } from "./checkpoint-coordinator";
import { assertProductionCheckpointSchema } from "./checkpoint-schema";
import { type MountedFreshRestoreRuntime } from "./fresh-restore-provisioner";
import { openFreshRestorePostgresPool } from "./postgres";
import type { ProductionRetainedArchive, ProductionRestoreScope } from "./restore-certification";
import type { MountedProductionSecretMaterial } from "./secret-material";
import { ProductionWorkerBridge } from "./worker-bridge";
import { ProductionWorkerOwnershipResolver } from "./worker-bridge";

type Expected = z.infer<typeof RestoreDrillInputSchema>["expected"];
type Google = ReturnType<typeof createGoogleDeploymentClients>;
const Identity = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);

type OpenedPool = Awaited<ReturnType<typeof openFreshRestorePostgresPool>>;
type RuntimeBinding = Readonly<{ freshInstanceId: string; databaseInstanceId: string; migrationDatabaseInstanceId: string; applicationInstanceId: string; providerOperationId: string }>;

/** Only a checkpoint carries a recoverable worker workspace. Other retained
 * kinds require their own recovered authority and archive reader. */
export function assertMountedFreshWorkspaceSubject(subject: z.infer<typeof DurabilitySubjectSchema>): void {
  if (subject.kind !== "checkpoint") throw new Error("MOUNTED_FRESH_RESTORE_SUBJECT_AUTHORITY_REQUIRED");
}

/**
 * Concrete restore runtime. The only values it accepts from the provisioner
 * are already-journaled resource identities; private IPs are observed from
 * Cloud SQL and credentials come from two fixed Secret Manager mounts. It has
 * no callback/evidence injection path.
 */
export function createMountedFreshRestoreRuntime(input: Readonly<{
  config: ProductionConfig;
  secrets: MountedProductionSecretMaterial;
  google: Google;
  artifactStore: GcsObjectStoreAdapter;
  observeTopology(): Promise<unknown>;
  now?: () => number;
}>): MountedFreshRestoreRuntime {
  if (!input.google || !input.artifactStore || typeof input.observeTopology !== "function") throw new Error("MOUNTED_FRESH_RESTORE_RUNTIME_REQUIRED");
  const now = input.now ?? Date.now;
  const poolFor = async (instanceId: string, binding: "cloudSql.restoreRecoveredRoleCredentialReference" | "cloudSql.restoreMigrationRoleCredentialReference") => {
    const observed = await input.google.cloudSqlPostgres.observePrivateAddress({ instanceId });
    if (observed.status !== "completed" || !("privateAddress" in observed)) throw new Error("MOUNTED_FRESH_RESTORE_PRIVATE_ADDRESS_UNAVAILABLE");
    return openFreshRestorePostgresPool({ config: input.config, secrets: input.secrets, binding, privateAddress: observed.privateAddress });
  };
  return Object.freeze({
    async open(raw): Promise<Readonly<{
      pool: PostgresSqlPool; migrationTargetPool: PostgresSqlPool; objectStore: GcsObjectStoreAdapter;
      startAfterRestore(): Promise<void>;
      openRetainedArchive(value: Readonly<{ subject: z.infer<typeof DurabilitySubjectSchema>; expected: Expected }>): Promise<ProductionRetainedArchive>;
      reattachOriginal(value: Readonly<{ sourceIdentity: string; archive: Uint8Array; expected: Expected }>): Promise<Readonly<{ status: "reattached" | "replayed" | "reconciliation_pending"; workerId?: string }>>;
      observeReattach(value: Readonly<{ sourceIdentity: string; archiveSha256: string; expected: Expected }>): Promise<Readonly<{ status: "reattached" | "replayed" | "reconciliation_pending"; workerId?: string }>>;
      exerciseExpiryDeletion(scope: ProductionRestoreScope): Promise<Readonly<{ expired: true; deleted: true }>>;
      observeExpiryDeletion(scope: ProductionRestoreScope): Promise<Readonly<{ expired: true; deleted: true }>>;
      observeTopology(): Promise<unknown>;
      cleanupLocal(): Promise<void>;
    }>> {
      const binding: RuntimeBinding = Object.freeze({ freshInstanceId: Identity.parse(raw.freshInstanceId), databaseInstanceId: Identity.parse(raw.databaseInstanceId), migrationDatabaseInstanceId: Identity.parse(raw.migrationDatabaseInstanceId), applicationInstanceId: Identity.parse(raw.applicationInstanceId), providerOperationId: Identity.parse(raw.providerOperationId) });
      if (binding.databaseInstanceId === binding.migrationDatabaseInstanceId) throw new Error("MOUNTED_FRESH_RESTORE_DISTINCT_DATABASES_REQUIRED");
      const [recovered, migration] = await Promise.all([
        poolFor(binding.databaseInstanceId, "cloudSql.restoreRecoveredRoleCredentialReference"),
        poolFor(binding.migrationDatabaseInstanceId, "cloudSql.restoreMigrationRoleCredentialReference"),
      ]);
      try { await assertZeroFundedVerificationPool(migration.pool); await assertProductionCheckpointSchema(recovered.pool); }
      catch (error) { await Promise.all([recovered.close(), migration.close()]); throw error; }
      /* Recreate every authority from the recovered database.  Retaining the
       * source-pool coordinator/bridge here would let a supposedly fresh drill
       * read or mutate the source authority after the clone completed. */
      const serviceJournals = await openProductionServiceJournals({ pool: recovered.pool, servicePubkey: input.config.certification.serverPubkey, initialTopologySha256: input.config.topologySha256, requireExisting: true }).catch(async error => { await Promise.all([recovered.close(), migration.close()]); throw error; });
      const workerClients = await createMountedProductionWorkerClients({ config: input.config, secrets: input.secrets, journal: createPostgresWorkerOperationJournal(serviceJournals.worker) }).catch(async error => { await Promise.all([recovered.close(), migration.close()]); throw error; });
      const jobRouter = await createMountedProductionWorkerJobRouter({ config: input.config, secrets: input.secrets, workerJournal: serviceJournals.worker, jobJournal: serviceJournals.job, current: workerClients }).catch(async error => { await Promise.all([recovered.close(), migration.close()]); throw error; });
      const checkpoint = new ProductionCheckpointCoordinator({
        pool: recovered.pool,
        objectStore: input.artifactStore,
        journal: serviceJournals.checkpoint,
        kekPath: input.secrets.path("checkpoint.kekReference"),
        now,
      });
      const capacityJournal = serviceJournals.capacity;
      const worker = new ProductionWorkerBridge({
        resolver: new ProductionWorkerOwnershipResolver({ pool: recovered.pool, policyVersion: input.config.worker.policyVersion, capacityJournal }),
        workers: workerClients.clients,
        jobRouter,
        workerJournal: serviceJournals.worker,
        jobJournal: serviceJournals.job,
        requestJournal: serviceJournals.request,
        artifactStore: input.artifactStore,
        toolchainSha256: input.config.worker.toolchainSha256,
        publication: { server: input.config.publication.uploadServer },
      });
      const checkpointFacts = async (expected: Expected, subject?: z.infer<typeof DurabilitySubjectSchema>) => {
        /* The checkpoint coordinator is the sole authority that can open a
         * workspace envelope. A durability registry row cannot convert an
         * artifact, evidence, receipt, or publication record into one. */
        if (subject) assertMountedFreshWorkspaceSubject(subject);
        const client = await recovered.pool.connect();
        try {
          const rows = await client.query<Record<string, unknown>>(
            "SELECT e.checkpoint_id,e.account_id,e.session_id,e.manifest_json,r.lease_token,r.action_id,r.expected_session_version,r.allocation_intent_reference FROM production_real.checkpoint_envelopes e JOIN production_real.funding_accounts f ON f.account_id=e.account_id LEFT JOIN production_real.continuation_resume_commands r ON r.checkpoint_id=e.checkpoint_id WHERE e.session_id=$1 AND trim(f.nostr_pubkey)=$2 AND e.state='retained' AND ($3::text IS NULL OR e.object_key=$3) ORDER BY e.checkpoint_id LIMIT 2",
            [expected.sessionId, expected.ownerId, subject?.object.key ?? null],
          );
          if (rows.rows.length !== 1) throw new Error("MOUNTED_FRESH_RESTORE_CHECKPOINT_BINDING_REQUIRED");
          const row = rows.rows[0]!;
          const manifest = z.object({ checkpointId: Identity, accountId: z.string().min(1), sessionId: Identity, pauseGeneration: z.number().int().nonnegative(), sessionVersion: z.number().int().nonnegative(), actionVersion: z.number().int().nonnegative(), workspaceLineage: z.string().min(1), archiveSha256: Digest, action: z.object({ actionId: Identity }).passthrough(), compatibility: z.object({ policyVersion: z.string().min(1) }).passthrough() }).passthrough().parse(typeof row.manifest_json === "string" ? JSON.parse(row.manifest_json) : row.manifest_json);
          if (manifest.checkpointId !== row.checkpoint_id || manifest.accountId !== row.account_id || manifest.sessionId !== expected.sessionId || manifest.archiveSha256 !== (subject?.payloadSha256 ?? manifest.archiveSha256)) throw new Error("MOUNTED_FRESH_RESTORE_CHECKPOINT_BINDING_REQUIRED");
          return Object.freeze({ manifest, accountId: String(row.account_id), leaseToken: typeof row.lease_token === "string" ? row.lease_token : undefined, actionId: typeof row.action_id === "string" ? row.action_id : undefined, expectedSessionVersion: Number(row.expected_session_version), allocationIntentReference: typeof row.allocation_intent_reference === "string" ? row.allocation_intent_reference : undefined });
        } finally { client.release(); }
      };
      return Object.freeze({
        pool: recovered.pool,
        migrationTargetPool: migration.pool,
        objectStore: input.artifactStore,
        async startAfterRestore() { const client = await recovered.pool.connect(); try { await client.query("SELECT 1"); } finally { client.release(); } },
        async openRetainedArchive(value) {
          assertMountedFreshWorkspaceSubject(value.subject);
          const facts = await checkpointFacts(value.expected, value.subject);
          const archive = await checkpoint.restore({ checkpointId: facts.manifest.checkpointId, accountId: facts.accountId, sessionId: facts.manifest.sessionId });
          return Object.freeze({ ...value.expected, archive });
        },
        async reattachOriginal(value) {
          const facts = await checkpointFacts(value.expected);
          if (!facts.leaseToken || !facts.actionId || !facts.allocationIntentReference || !Number.isInteger(facts.expectedSessionVersion) || facts.expectedSessionVersion < 0) throw new Error("MOUNTED_FRESH_RESTORE_RESUME_BINDING_REQUIRED");
          const archive = new Uint8Array(new ArrayBuffer(value.archive.byteLength)); archive.set(value.archive);
          const restore = { accountId: facts.accountId, sessionId: facts.manifest.sessionId, actionId: facts.actionId, expectedVersion: facts.expectedSessionVersion, policyVersion: facts.manifest.compatibility.policyVersion, capabilityGrant: "phase-05-continuation-grant" as const, workspaceId: facts.manifest.workspaceLineage, checkpointId: facts.manifest.checkpointId, pauseGeneration: facts.manifest.pauseGeneration, actionVersion: facts.manifest.actionVersion, workspaceLineage: facts.manifest.workspaceLineage, leaseToken: facts.leaseToken, resumeClaim: facts.allocationIntentReference, archive, archiveSha256: facts.manifest.archiveSha256 };
          /* Fence the original source worker before the cloned authority can
           * attach it. The fence is durable and idempotent in the cloned job
           * journal, so concurrent restores cannot race an active writer. */
          if ((await worker.fenceCheckpoint(restore)).status !== "fenced") throw new Error("MOUNTED_FRESH_RESTORE_SOURCE_FENCE_REQUIRED");
          const result = await worker.restoreCheckpoint(restore);
          return result.status === "restored" ? Object.freeze({ status: "reattached" as const, workerId: result.workspaceId }) : Object.freeze({ status: "reconciliation_pending" as const });
        },
        async observeReattach(value) {
          const facts = await checkpointFacts(value.expected);
          if (facts.manifest.archiveSha256 !== value.archiveSha256 || !value.sourceIdentity) throw new Error("MOUNTED_FRESH_RESTORE_REATTACH_BINDING_REQUIRED");
          if (!facts.leaseToken || !facts.actionId || !facts.allocationIntentReference || !Number.isInteger(facts.expectedSessionVersion) || facts.expectedSessionVersion < 0) throw new Error("MOUNTED_FRESH_RESTORE_RESUME_BINDING_REQUIRED");
          const observed = await worker.observeRestoreCheckpoint({ accountId: facts.accountId, sessionId: facts.manifest.sessionId, actionId: facts.actionId, expectedVersion: facts.expectedSessionVersion, policyVersion: facts.manifest.compatibility.policyVersion, capabilityGrant: "phase-05-continuation-grant", workspaceId: facts.manifest.workspaceLineage, checkpointId: facts.manifest.checkpointId, pauseGeneration: facts.manifest.pauseGeneration, actionVersion: facts.manifest.actionVersion, workspaceLineage: facts.manifest.workspaceLineage, leaseToken: facts.leaseToken, resumeClaim: facts.allocationIntentReference, archiveSha256: value.archiveSha256 });
          return observed.status === "restored" ? Object.freeze({ status: "reattached" as const, workerId: observed.workerId }) : observed.status === "pending" ? Object.freeze({ status: "reconciliation_pending" as const }) : Object.freeze({ status: "reconciliation_pending" as const });
        },
        async exerciseExpiryDeletion(scope) {
          const facts = await checkpointFacts({ ownerId: scope.ownerId, sessionId: scope.sessionId, pendingActionReference: "expiry", sessionVersion: 0, artifactVersion: 0, leaseToken: "expiry", compatibility: { policyVersion: "expiry", modelIdentity: "expiry", nappletSdkIdentity: "expiry", toolchainIdentity: "expiry" } });
          if (Date.parse((await checkpointManifestRetention(recovered.pool, facts.manifest.checkpointId))) > now()) throw new Error("MOUNTED_FRESH_RESTORE_EXPIRY_NOT_DUE");
          await checkpoint.destroyExpired({ checkpointId: facts.manifest.checkpointId, accountId: facts.accountId, sessionId: facts.manifest.sessionId });
          if (!await checkpoint.observeDestroyed({ checkpointId: facts.manifest.checkpointId, accountId: facts.accountId, sessionId: facts.manifest.sessionId })) throw new Error("MOUNTED_FRESH_RESTORE_EXPIRY_UNCONFIRMED");
          return Object.freeze({ expired: true as const, deleted: true as const });
        },
        async observeExpiryDeletion(scope) {
          const client = await recovered.pool.connect();
          try {
            const row = (await client.query<Record<string, unknown>>("SELECT account_id,state FROM production_real.checkpoint_envelopes WHERE checkpoint_id=$1 AND session_id=$2", [scope.checkpointId, scope.sessionId])).rows[0];
            if (!row || row.state !== "destroyed" || !await checkpoint.observeDestroyed({ checkpointId: scope.checkpointId, accountId: String(row.account_id), sessionId: scope.sessionId })) throw new Error("MOUNTED_FRESH_RESTORE_EXPIRY_UNCONFIRMED");
            return Object.freeze({ expired: true as const, deleted: true as const });
          } finally { client.release(); }
        },
        observeTopology: input.observeTopology,
        async cleanupLocal() { await Promise.all([recovered.close(), migration.close()]); },
      });
    },
  });
}

async function assertZeroFundedVerificationPool(pool: PostgresSqlPool): Promise<void> {
  const client = await pool.connect();
  try {
    const relation = (await client.query<Record<string, unknown>>("SELECT to_regclass('production_real.account_balance_projection') AS relation")).rows[0]?.relation;
    if (relation) {
      const funded = await client.query("SELECT 1 FROM production_real.account_balance_projection WHERE settled_available <> 0 OR held <> 0 LIMIT 1");
      if (funded.rows.length) throw new Error("MOUNTED_FRESH_RESTORE_MIGRATION_TARGET_NOT_ZERO_FUNDED");
    }
  } finally { client.release(); }
}

async function checkpointManifestRetention(pool: PostgresSqlPool, checkpointId: string): Promise<string> {
  const client = await pool.connect();
  try {
    const row = (await client.query<Record<string, unknown>>("SELECT retention_until::text AS retention_until FROM production_real.checkpoint_envelopes WHERE checkpoint_id=$1 AND state='retained'", [checkpointId])).rows[0];
    if (!row || typeof row.retention_until !== "string" || !Number.isFinite(Date.parse(row.retention_until))) throw new Error("MOUNTED_FRESH_RESTORE_RETENTION_UNAVAILABLE");
    return row.retention_until;
  } finally { client.release(); }
}
