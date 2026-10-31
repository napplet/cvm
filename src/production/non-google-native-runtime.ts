import { z } from "zod";
import { assertPostgresOperationJournal, type OperationRecord, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { assertProductionReadyCapacity, type ProductionReadyCapacityPort } from "./worker-capacity";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Identity = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u);
export type NonGoogleCoreBinding = Readonly<{ candidateSha256: string; topologySha256: string }>;
export type NonGoogleJournalRecord<T = unknown> = OperationRecord<T>;

/** Production-only journal view. It wraps the restricted durable PostgreSQL
 * journal and intentionally has no in-memory or caller-result alternative. */
export class NonGoogleCoreJournal {
  private constructor(private readonly postgres: PostgresOperationJournal) { Object.freeze(this); }
  static fromPostgres(journal: PostgresOperationJournal): NonGoogleCoreJournal { assertPostgresOperationJournal(journal); return new NonGoogleCoreJournal(journal); }
  #key(operationId: string) { return `non-google-core:${Identity.parse(operationId)}`; }
  async claim<T>(operationId: string, identitySha256: string, value: T) { return this.postgres.claim(this.#key(operationId), Digest.parse(identitySha256), value); }
  async read<T>(operationId: string) { return this.postgres.read<T>(this.#key(operationId)); }
  async replace<T>(operationId: string, identitySha256: string, revision: number, value: T) { return this.postgres.compareAndSet(this.#key(operationId), Digest.parse(identitySha256), revision, value); }
}

/** Direct, asserted production capacity implementation. The core keeps no
 * capacity callback or fabricated readiness report. */
export class NonGoogleNativeCapacity {
  private constructor(private readonly port: ProductionReadyCapacityPort) { Object.freeze(this); }
  static fromProduction(port: ProductionReadyCapacityPort): NonGoogleNativeCapacity { assertProductionReadyCapacity(port); return new NonGoogleNativeCapacity(port); }
  reserve(input: Readonly<{ intentReference: string; expectedSessionBindingDigest: string }>) { return this.port.reserveNow(input); }
  observe(input: Readonly<{ intentReference: string; expectedSessionBindingDigest: string; reference?: string }>) { return this.port.observe(input); }
}
