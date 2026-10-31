import { z } from "zod";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { assertProductionReadyCapacity, type ProductionReadyCapacityPort } from "./worker-capacity";
import { NonGoogleCoolifyDriver } from "./non-google-coolify-driver";
import { NonGoogleFreshRestoreDriver } from "./non-google-fresh-restore-driver";
import { NonGooglePostgresDriver } from "./non-google-postgres";
import { NonGoogleSigNozDriver } from "./non-google-signoz-driver";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);

/** Sealed controller-owned native dependency set. Every member has actual
 * implementation code; construction validates references only and performs no
 * secret read, SQL connection, network request, resource operation, or report. */
export class NonGoogleNativeCoreDriverSet {
  readonly candidateSha256: string;
  readonly topologySha256: string;
  readonly roleCostBoundSha256: string;
  constructor(input: Readonly<{
    candidateSha256: string;
    topologySha256: string;
    roleCostBoundSha256: string;
    journal: PostgresOperationJournal;
    capacity: ProductionReadyCapacityPort;
    postgres: NonGooglePostgresDriver;
    coolify: NonGoogleCoolifyDriver;
    signoz: NonGoogleSigNozDriver;
    restore: NonGoogleFreshRestoreDriver;
    restoreScope: Readonly<{ checkpointId: string; sessionId: string; ownerId: string }>;
    custodyRoots: readonly string[];
  }>) {
    assertPostgresOperationJournal(input.journal);
    assertProductionReadyCapacity(input.capacity);
    if (!(input.postgres instanceof NonGooglePostgresDriver) || !(input.coolify instanceof NonGoogleCoolifyDriver) || !(input.signoz instanceof NonGoogleSigNozDriver) || !(input.restore instanceof NonGoogleFreshRestoreDriver)) throw new Error("NON_GOOGLE_NATIVE_DRIVER_REQUIRED");
    if (input.restore.coolify !== input.coolify) throw new Error("NON_GOOGLE_NATIVE_RESTORE_COOLIFY_REQUIRED");
    this.candidateSha256 = Digest.parse(input.candidateSha256);
    this.topologySha256 = Digest.parse(input.topologySha256);
    this.roleCostBoundSha256 = Digest.parse(input.roleCostBoundSha256);
    this.restoreScope = Object.freeze({ checkpointId: z.string().min(1).parse(input.restoreScope.checkpointId), sessionId: z.string().min(1).parse(input.restoreScope.sessionId), ownerId: Digest.parse(input.restoreScope.ownerId) });
    this.custodyRoots = Object.freeze([...input.custodyRoots]);
    if (this.custodyRoots.length === 0) throw new Error("NON_GOOGLE_NATIVE_CUSTODY_ROOT_REQUIRED");
    this.journal = input.journal; this.capacity = input.capacity; this.postgres = input.postgres; this.coolify = input.coolify; this.signoz = input.signoz; this.restore = input.restore;
    Object.freeze(this);
  }
  readonly journal: PostgresOperationJournal;
  readonly capacity: ProductionReadyCapacityPort;
  readonly postgres: NonGooglePostgresDriver;
  readonly coolify: NonGoogleCoolifyDriver;
  readonly signoz: NonGoogleSigNozDriver;
  readonly restore: NonGoogleFreshRestoreDriver;
  readonly restoreScope: Readonly<{ checkpointId: string; sessionId: string; ownerId: string }>;
  readonly custodyRoots: readonly string[];
}
export function assertNonGoogleNativeCoreDriverSet(value: unknown): asserts value is NonGoogleNativeCoreDriverSet {
  if (!(value instanceof NonGoogleNativeCoreDriverSet)) throw new Error("NON_GOOGLE_NATIVE_DRIVER_SET_REQUIRED");
}
