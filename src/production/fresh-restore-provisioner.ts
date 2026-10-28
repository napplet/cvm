import { createHash } from "node:crypto";
import { z } from "zod";
import { createGoogleDeploymentClients } from "../release/deployment/google-clients";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import type { ObjectStorePort } from "../continuity/object-store";
import type { ProductionFreshRestoreInstance, ProductionFreshRestoreProvisioner, ProductionRetainedArchive, ProductionRestoreScope } from "./restore-certification";
import type { DurabilitySubjectSchema } from "../resilience/fault-harness";
import type { RestoreDrillInputSchema } from "../resilience/fault-harness";

const Id = z.string().regex(/^[a-z][a-z0-9-]{2,96}[a-z0-9]$/u);
const Operation = z.string().regex(/^[a-z][a-z0-9_-]{2,54}$/u);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
type Expected = z.infer<typeof RestoreDrillInputSchema>['expected'];
type Google = ReturnType<typeof createGoogleDeploymentClients>;

/**
 * The mounted application runtime may open only a provider-observed pair of
 * fresh SQL instances and service. It receives no caller-provided identities
 * or arbitrary callbacks, and is where mounted SQL credentials, GCS, KEK and
 * the worker bridge are assembled by the production session material.
 */
export type MountedFreshRestoreRuntime = Readonly<{
  open(input: Readonly<{
    freshInstanceId: string;
    databaseInstanceId: string;
    migrationDatabaseInstanceId: string;
    applicationInstanceId: string;
    providerOperationId: string;
  }>): Promise<Readonly<{
    pool: PostgresSqlPool;
    migrationTargetPool: PostgresSqlPool;
    objectStore: ObjectStorePort;
    startAfterRestore(): Promise<void>;
    openRetainedArchive(input: Readonly<{ subject: z.infer<typeof DurabilitySubjectSchema>; expected: Expected }>): Promise<ProductionRetainedArchive>;
    reattachOriginal(input: Readonly<{ sourceIdentity: string; archive: Uint8Array; expected: Expected }>): Promise<Readonly<{ status: "reattached" | "replayed" | "reconciliation_pending"; workerId?: string }>>;
    observeReattach(input: Readonly<{ sourceIdentity: string; archiveSha256: string; expected: Expected }>): Promise<Readonly<{ status: "reattached" | "replayed" | "reconciliation_pending"; workerId?: string }>>;
    exerciseExpiryDeletion(scope: ProductionRestoreScope): Promise<Readonly<{ expired: true; deleted: true }>>;
    observeExpiryDeletion(scope: ProductionRestoreScope): Promise<Readonly<{ expired: true; deleted: true }>>;
    observeTopology(): Promise<unknown>;
    cleanupLocal(): Promise<void>;
  }>>;
}>;

export type ProductionFreshRestoreProvisioning = Readonly<{
  google: Google;
  projectId: string;
  region: string;
  cloudSql: Readonly<{ tier: string; privateNetwork: string; storageGb: number }>;
  cloudRun: Readonly<{
    imageReference: string;
    serviceAccountReference: string;
    environmentReferenceSha256: string;
    secretReferences: readonly Readonly<{ name: string; secret: string; version: string }>[];
    concurrency: number;
  }>;
  runtime: MountedFreshRestoreRuntime;
}>;

type Binding = Readonly<{
  freshInstanceId: string; databaseInstanceId: string; migrationDatabaseInstanceId: string; applicationInstanceId: string; providerOperationId: string;
}>;

function requireCompleted(status: Readonly<{ status: string }>, code: string): void {
  if (status.status === "completed") return;
  if (status.status === "pending") throw new Error(`${code}_PENDING`);
  throw new Error(`${code}_${status.status.toUpperCase()}`);
}

/**
 * Real provider orchestration for the protected restore suite. Every resource
 * name and provider operation is deterministic from the original control
 * operation. Re-entry therefore observes the original clone/provision/deploy
 * rather than dispatching a second database or Cloud Run service.
 */
export class ProductionGoogleFreshRestoreProvisioner implements ProductionFreshRestoreProvisioner {
  constructor(private readonly input: ProductionFreshRestoreProvisioning) {
    if (!input.google || !input.runtime || typeof input.runtime.open !== "function") throw new Error("PRODUCTION_FRESH_RESTORE_MOUNT_REQUIRED");
    z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u).parse(input.projectId);
    z.string().regex(/^[a-z]+-[a-z]+[0-9]$/u).parse(input.region);
    z.string().regex(/^db-custom-[1-9][0-9]*-[1-9][0-9]*$/u).parse(input.cloudSql.tier);
    z.string().min(1).parse(input.cloudSql.privateNetwork);
    z.number().int().min(10).max(65_536).parse(input.cloudSql.storageGb);
    z.string().regex(/^.+@sha256:[a-f0-9]{64}$/iu).parse(input.cloudRun.imageReference);
    z.string().min(1).parse(input.cloudRun.serviceAccountReference);
    Digest.parse(input.cloudRun.environmentReferenceSha256);
    if (!Number.isInteger(input.cloudRun.concurrency) || input.cloudRun.concurrency < 1 || input.cloudRun.concurrency > 1_000) throw new Error("PRODUCTION_FRESH_RESTORE_CONCURRENCY_INVALID");
  }

  async create(input: Readonly<{ operationId: string; sourceInstanceId: string; backupSha256: string }>): Promise<ProductionFreshRestoreInstance> {
    const binding = this.#binding(input.operationId); const sourceInstanceId = Id.parse(input.sourceInstanceId); Digest.parse(input.backupSha256);
    const clone = await this.input.google.cloudSqlPostgres.clone({ operationId: binding.providerOperationId, sourceInstanceId, destinationInstanceId: binding.databaseInstanceId });
    requireCompleted(clone.status === "pending" ? await this.input.google.cloudSqlPostgres.observeClone({ operationId: binding.providerOperationId, sourceInstanceId, destinationInstanceId: binding.databaseInstanceId }) : clone, "PRODUCTION_FRESH_RESTORE_CLONE");
    await this.#emptyMigrationTarget(binding);
    await this.#freshApplication(binding);
    return this.#open(binding, sourceInstanceId);
  }

  async attach(input: Readonly<{ freshInstanceId: string; sourceInstanceId: string; databaseInstanceId: string; migrationDatabaseInstanceId: string; applicationInstanceId: string; providerOperationId: string }>): Promise<ProductionFreshRestoreInstance> {
    const binding = this.#parseBinding(input);
    const sourceInstanceId = Id.parse(input.sourceInstanceId);
    const clone = await this.input.google.cloudSqlPostgres.observeClone({ operationId: binding.providerOperationId, sourceInstanceId, destinationInstanceId: binding.databaseInstanceId });
    requireCompleted(clone, "PRODUCTION_FRESH_RESTORE_CLONE");
    const migration = await this.input.google.cloudSqlPostgres.observe({ operationId: `${binding.providerOperationId}-verify`, instanceId: binding.migrationDatabaseInstanceId, region: this.input.region, tier: this.input.cloudSql.tier, privateNetwork: this.input.cloudSql.privateNetwork, storageGb: this.input.cloudSql.storageGb });
    requireCompleted(migration, "PRODUCTION_FRESH_RESTORE_MIGRATION_TARGET");
    const app = await this.input.google.cloudRun.observe({ operationId: `${binding.providerOperationId}-app`, projectId: this.input.projectId, region: this.input.region, serviceName: binding.applicationInstanceId, imageReference: this.input.cloudRun.imageReference, serviceAccountReference: this.input.cloudRun.serviceAccountReference, environmentReferenceSha256: this.input.cloudRun.environmentReferenceSha256, secretReferences: this.input.cloudRun.secretReferences, concurrency: this.input.cloudRun.concurrency });
    requireCompleted(app, "PRODUCTION_FRESH_RESTORE_APPLICATION");
    return this.#open(binding, sourceInstanceId);
  }

  async observeCleanup(input: Readonly<{ freshInstanceId: string; sourceInstanceId: string; databaseInstanceId: string; migrationDatabaseInstanceId: string; applicationInstanceId: string; providerOperationId: string }>): Promise<Readonly<{ state: "absent" | "unknown" }>> {
    const binding = this.#parseBinding(input); const sourceInstanceId = Id.parse(input.sourceInstanceId);
    return this.#observeCleanup(binding, sourceInstanceId);
  }

  #binding(operationId: string): Binding {
    const digest = sha(Operation.parse(operationId)).slice(0, 24);
    return Object.freeze({ freshInstanceId: `restore-${digest}`, databaseInstanceId: `restore-sql-${digest}`, migrationDatabaseInstanceId: `restore-verify-${digest}`, applicationInstanceId: `restore-app-${digest}`, providerOperationId: `restore-${digest}` });
  }
  #parseBinding(value: Readonly<{ freshInstanceId: string; databaseInstanceId: string; migrationDatabaseInstanceId: string; applicationInstanceId: string; providerOperationId: string }>): Binding {
    const binding = Object.freeze({ freshInstanceId: Id.parse(value.freshInstanceId), databaseInstanceId: Id.parse(value.databaseInstanceId), migrationDatabaseInstanceId: Id.parse(value.migrationDatabaseInstanceId), applicationInstanceId: Id.parse(value.applicationInstanceId), providerOperationId: Operation.parse(value.providerOperationId) });
    const suffix = binding.providerOperationId.slice("restore-".length);
    if (!binding.providerOperationId.startsWith("restore-") || binding.freshInstanceId !== `restore-${suffix}` || binding.databaseInstanceId !== `restore-sql-${suffix}` || binding.migrationDatabaseInstanceId !== `restore-verify-${suffix}` || binding.applicationInstanceId !== `restore-app-${suffix}`) throw new Error("PRODUCTION_FRESH_RESTORE_BINDING_DENIED");
    return binding;
  }
  async #emptyMigrationTarget(binding: Binding): Promise<void> {
    const operationId = `${binding.providerOperationId}-verify`;
    const started = await this.input.google.cloudSqlPostgres.provision({ operationId, instanceId: binding.migrationDatabaseInstanceId, region: this.input.region, databaseVersion: "POSTGRES_17", availabilityType: "REGIONAL", tier: this.input.cloudSql.tier, privateNetwork: this.input.cloudSql.privateNetwork, storageGb: this.input.cloudSql.storageGb, requireSsl: true, serializablePolicy: true });
    requireCompleted(started.status === "pending" ? await this.input.google.cloudSqlPostgres.observe({ operationId, instanceId: binding.migrationDatabaseInstanceId, region: this.input.region, tier: this.input.cloudSql.tier, privateNetwork: this.input.cloudSql.privateNetwork, storageGb: this.input.cloudSql.storageGb }) : started, "PRODUCTION_FRESH_RESTORE_MIGRATION_TARGET");
  }
  async #freshApplication(binding: Binding): Promise<void> {
    const operationId = `${binding.providerOperationId}-app`;
    const started = await this.input.google.cloudRun.deploy({ operationId, projectId: this.input.projectId, region: this.input.region, serviceName: binding.applicationInstanceId, imageReference: this.input.cloudRun.imageReference, serviceAccountReference: this.input.cloudRun.serviceAccountReference, environmentReferenceSha256: this.input.cloudRun.environmentReferenceSha256, secretReferences: this.input.cloudRun.secretReferences, minimumInstances: 3, ingress: "internal-and-cloud-load-balancing", concurrency: this.input.cloudRun.concurrency, admissionRefusal: "capacity_unavailable" });
    requireCompleted(started.status === "pending" ? await this.input.google.cloudRun.observe({ operationId, projectId: this.input.projectId, region: this.input.region, serviceName: binding.applicationInstanceId, imageReference: this.input.cloudRun.imageReference, serviceAccountReference: this.input.cloudRun.serviceAccountReference, environmentReferenceSha256: this.input.cloudRun.environmentReferenceSha256, secretReferences: this.input.cloudRun.secretReferences, concurrency: this.input.cloudRun.concurrency }) : started, "PRODUCTION_FRESH_RESTORE_APPLICATION");
  }
  async #open(binding: Binding, sourceInstanceId: string): Promise<ProductionFreshRestoreInstance> {
    const runtime = await this.input.runtime.open(binding);
    const cleanup = async () => {
      await runtime.cleanupLocal();
      const app = await this.input.google.cloudRun.cleanup({ operationId: `${binding.providerOperationId}-app`, projectId: this.input.projectId, region: this.input.region, serviceName: binding.applicationInstanceId }); requireCompleted(app, "PRODUCTION_FRESH_RESTORE_APPLICATION_CLEANUP");
      const target = await this.input.google.cloudSqlPostgres.cleanup({ operationId: `${binding.providerOperationId}-verify`, instanceId: binding.migrationDatabaseInstanceId }); requireCompleted(target, "PRODUCTION_FRESH_RESTORE_MIGRATION_TARGET_CLEANUP");
      const clone = await this.input.google.cloudSqlPostgres.cleanup({ operationId: binding.providerOperationId, instanceId: binding.databaseInstanceId }); requireCompleted(clone, "PRODUCTION_FRESH_RESTORE_CLONE_CLEANUP");
      return Object.freeze({ state: "absent" as const });
    };
    return Object.freeze({ ...binding, sourceInstanceId, pool: runtime.pool, migrationTargetPool: runtime.migrationTargetPool, objectStore: runtime.objectStore, startAfterRestore: runtime.startAfterRestore, openRetainedArchive: runtime.openRetainedArchive, reattachOriginal: runtime.reattachOriginal, observeReattach: runtime.observeReattach, exerciseExpiryDeletion: runtime.exerciseExpiryDeletion, observeExpiryDeletion: runtime.observeExpiryDeletion, observeTopology: runtime.observeTopology, cleanup, observeCleanup: () => this.#observeCleanup(binding, sourceInstanceId) });
  }
  async #observeCleanup(binding: Binding, sourceInstanceId: string): Promise<Readonly<{ state: "absent" | "unknown" }>> {
    /* These are GET-only observations of the original resource identities.
     * A lost cleanup acknowledgement must never send another DELETE. */
    const app = await this.input.google.cloudRun.observeCleanup({ operationId: `${binding.providerOperationId}-app`, projectId: this.input.projectId, region: this.input.region, serviceName: binding.applicationInstanceId });
    const [target, clone] = await Promise.all([
      this.input.google.cloudSqlPostgres.observe({ operationId: `${binding.providerOperationId}-verify`, instanceId: binding.migrationDatabaseInstanceId, region: this.input.region, tier: this.input.cloudSql.tier, privateNetwork: this.input.cloudSql.privateNetwork, storageGb: this.input.cloudSql.storageGb }),
      this.input.google.cloudSqlPostgres.observeClone({ operationId: binding.providerOperationId, sourceInstanceId, destinationInstanceId: binding.databaseInstanceId }),
    ]);
    return app.status === "completed" && target.status === "missing" && clone.status === "missing" ? Object.freeze({ state: "absent" as const }) : Object.freeze({ state: "unknown" as const });
  }
}
