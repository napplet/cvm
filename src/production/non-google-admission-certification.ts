import { createHash } from "node:crypto";
import { z } from "zod";
import { CoreControlPayloadSchemas } from "../release/deployment/production-core-suite-protocol";
import type { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import type { NonGoogleCoreBinding, NonGoogleCoreHeld } from "./non-google-telemetry-certification";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Candidate-bound admission records. This is deliberately not a capacity
 * provider: the held graph has no authority to reserve, start, or select one. */
export class NonGoogleAdmissionCertification {
  constructor(private readonly input: Readonly<{ binding: NonGoogleCoreBinding; journal?: PostgresOperationJournal }>) { Object.freeze(this); }
  async prepare(input: Readonly<{ operationId: string; candidateId: string; provider: "modal" | "fly"; sample: unknown }>): Promise<Readonly<{ status: "prepared" } | NonGoogleCoreHeld>> {
    const { operationId, ...payload } = input;
    const parsed = CoreControlPayloadSchemas["cohort.prepare"].parse(payload);
    if (parsed.candidateId !== this.input.binding.candidateSha256) throw new Error("NON_GOOGLE_ADMISSION_CANDIDATE_DENIED");
    if (!this.input.journal) return Object.freeze({ status: "held" as const, reason: "SUCCESSOR_AUTHORITY_HELD" as const });
    const identity = sha({ version: 1, binding: this.input.binding, operationId, ...parsed });
    await this.input.journal.claim(`non-google-admission:${operationId}`, identity, { version: 1, binding: this.input.binding, operationId, ...parsed, state: "prepared" });
    return Object.freeze({ status: "prepared" as const });
  }
  async observe(input: Readonly<{ operationId: string; candidateId: string; provider: "modal" | "fly"; sample: unknown }>): Promise<Readonly<{ status: "observed" } | NonGoogleCoreHeld>> {
    const { operationId, ...payload } = input;
    const parsed = CoreControlPayloadSchemas["cohort.observe"].parse(payload);
    if (parsed.candidateId !== this.input.binding.candidateSha256) throw new Error("NON_GOOGLE_ADMISSION_CANDIDATE_DENIED");
    if (!this.input.journal) return Object.freeze({ status: "held" as const, reason: "COLLECTOR_OBSERVATION_HELD" as const });
    const original = await this.input.journal.read(`non-google-admission:${operationId}`);
    if (!original) throw new Error("NON_GOOGLE_ADMISSION_ORIGINAL_REQUIRED");
    return Object.freeze({ status: "observed" as const });
  }
}
