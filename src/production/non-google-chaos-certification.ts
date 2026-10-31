import { createHash } from "node:crypto";
import { z } from "zod";
import { D122_FAULT_MATRIX } from "../resilience/fault-harness";
import { canonicalJson } from "../promotion/schema";
import type { NonGoogleCoreBinding } from "./non-google-native-runtime";
import { NonGoogleChaosTransport, NonGoogleCoreJournal } from "./non-google-native-runtime";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
type Original = Readonly<{ version: 1; binding: NonGoogleCoreBinding; operationId: string; sessionId: string; controlOperationId: string; schedule: unknown; state: "claimed" | "applied" }>;

/** D-122 faults use schedule.input.operationId as the sole domain identity.
 * The supplied control ID is persisted separately and cannot make an unrelated
 * relay command look reconcilable. Only acknowledged transport ambiguity gets
 * an observe call; binding and validation failures propagate unchanged. */
export class NonGoogleChaosCertification {
  constructor(private readonly input: Readonly<{ binding: NonGoogleCoreBinding; journal: NonGoogleCoreJournal; transport: NonGoogleChaosTransport }>) { Object.freeze(this); }
  #key(operationId: string) { return `fault:${z.string().min(1).parse(operationId)}`; }
  async inject(input: Readonly<{ operationId: string; schedule: unknown }>): Promise<Readonly<{ status: "recorded"; operationId: string; sessionId: string }>> {
    const schedule = D122_FAULT_MATRIX.find(item => canonicalJson(item) === canonicalJson(input.schedule));
    if (!schedule) throw new Error("NON_GOOGLE_CHAOS_SCHEDULE_DENIED");
    const original: Original = Object.freeze({ version: 1, binding: this.input.binding, operationId: schedule.input.operationId, sessionId: schedule.initialState.sessionId, controlOperationId: z.string().min(1).parse(input.operationId), schedule, state: "claimed" });
    const claim = await this.input.journal.claim(this.#key(original.operationId), hash(original), original);
    if (!claim.claimed) return Object.freeze({ status: "recorded" as const, operationId: claim.record.value.operationId, sessionId: claim.record.value.sessionId });
    const dispatched = await this.input.transport.injectOriginal({ operationId: original.operationId, sessionId: original.sessionId, schedule, binding: this.input.binding });
    if (dispatched.operationId !== original.operationId || dispatched.sessionId !== original.sessionId) throw new Error("NON_GOOGLE_CHAOS_TRANSPORT_BINDING_DENIED");
    if (dispatched.status !== "applied") {
      if (dispatched.status === "pending") throw new Error("NON_GOOGLE_CHAOS_TRANSPORT_AMBIGUOUS");
      throw new Error("NON_GOOGLE_CHAOS_TRANSPORT_BLOCKED");
    }
    if (!await this.input.journal.replace(this.#key(original.operationId), claim.record.identitySha256, claim.record.revision, Object.freeze({ ...original, state: "applied" as const }))) throw new Error("NON_GOOGLE_CHAOS_RECORD_CONFLICT");
    return Object.freeze({ status: "recorded" as const, operationId: original.operationId, sessionId: original.sessionId });
  }
  async observe(input: Readonly<{ operationId: string; sessionId: string }>): Promise<Readonly<{ status: "observed"; operationId: string; sessionId: string }>> {
    const operationId = z.string().min(1).parse(input.operationId); const sessionId = z.string().min(1).parse(input.sessionId);
    const original = await this.input.journal.read<Original>(this.#key(operationId));
    if (!original || original.value.operationId !== operationId || original.value.sessionId !== sessionId || original.value.state !== "applied") throw new Error("NON_GOOGLE_CHAOS_ORIGINAL_REQUIRED");
    const observed = await this.input.transport.observeOriginal({ operationId, sessionId, binding: this.input.binding });
    if (observed.operationId !== operationId || observed.sessionId !== sessionId) throw new Error("NON_GOOGLE_CHAOS_OBSERVATION_BINDING_DENIED");
    if (observed.status === "observed") return Object.freeze({ status: "observed" as const, operationId, sessionId });
    if (observed.status === "pending") throw new Error("NON_GOOGLE_CHAOS_OBSERVATION_PENDING");
    throw new Error("NON_GOOGLE_CHAOS_OBSERVATION_UNAVAILABLE");
  }
}
