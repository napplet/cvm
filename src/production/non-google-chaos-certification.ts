import { createHash } from "node:crypto";
import { z } from "zod";
import { D122_FAULT_MATRIX } from "../resilience/fault-harness";
import { canonicalJson } from "../promotion/schema";
import type { PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import type { NonGoogleCoreBinding, NonGoogleCoreHeld } from "./non-google-telemetry-certification";

const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const Fault = z.object({ operationId: z.string().min(1), sessionId: z.string().min(1) }).strict();

/** Disjoint non-Google D-122 journal path. It deliberately contains no
 * historical provider names, receipt parser, or default authority fallback. */
export class NonGoogleChaosCertification {
  constructor(private readonly input: Readonly<{ binding: NonGoogleCoreBinding; journal?: PostgresOperationJournal }>) { Object.freeze(this); }
  async inject(input: Readonly<{ operationId: string; schedule: unknown }>): Promise<Readonly<{ status: "recorded" } | NonGoogleCoreHeld>> {
    const schedule = D122_FAULT_MATRIX.find(item => canonicalJson(item) === canonicalJson(input.schedule));
    if (!schedule) throw new Error("NON_GOOGLE_CHAOS_SCHEDULE_DENIED");
    if (!this.input.journal) return Object.freeze({ status: "held" as const, reason: "SUCCESSOR_AUTHORITY_HELD" as const });
    const identity = sha({ version: 1, binding: this.input.binding, operationId: input.operationId, schedule });
    await this.input.journal.claim(`non-google-chaos:${input.operationId}`, identity, { version: 1, binding: this.input.binding, operationId: input.operationId, schedule, state: "claimed" });
    return Object.freeze({ status: "recorded" as const });
  }
  async observe(input: Readonly<{ operationId: string; sessionId: string }>): Promise<Readonly<{ status: "observed" } | NonGoogleCoreHeld>> {
    const original = Fault.parse(input);
    if (!D122_FAULT_MATRIX.some(item => item.input.operationId === original.operationId && item.initialState.sessionId === original.sessionId)) throw new Error("NON_GOOGLE_CHAOS_ORIGINAL_DENIED");
    if (!this.input.journal) return Object.freeze({ status: "held" as const, reason: "SUCCESSOR_AUTHORITY_HELD" as const });
    const records = await Promise.all(D122_FAULT_MATRIX.filter(item => item.input.operationId === original.operationId).map(item => this.input.journal!.read(`non-google-chaos:${item.input.operationId}`)));
    if (records.every(record => !record)) return Object.freeze({ status: "held" as const, reason: "COLLECTOR_OBSERVATION_HELD" as const });
    return Object.freeze({ status: "observed" as const });
  }
}
