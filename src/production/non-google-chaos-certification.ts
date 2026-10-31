import { createHash } from "node:crypto";
import { z } from "zod";
import { D122_FAULT_MATRIX, EffectOracleSchema, FaultExecutionSchema } from "../resilience/fault-harness";
import { canonicalJson } from "../promotion/schema";
import type { NonGoogleCoreBinding } from "./non-google-native-runtime";
import { NonGoogleCoreJournal } from "./non-google-native-runtime";
import { NonGoogleCoolifyDriver } from "./non-google-coolify-driver";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
type Original = Readonly<{ version: 2; binding: NonGoogleCoreBinding; operationId: string; sessionId: string; controlOperationId: string; schedule: unknown; oracle: z.infer<typeof EffectOracleSchema>; state: "claimed" }>;

/** No structural transport exists in this path. Unsupported D122 boundaries
 * stay honestly unavailable until a controller binds the corresponding native
 * domain actuator; a Coolify driver is present only for its documented app
 * lifecycle operations and never receives a fabricated UUID. */
export class NonGoogleChaosCertification {
  constructor(private readonly input: Readonly<{ binding: NonGoogleCoreBinding; journal: NonGoogleCoreJournal; coolify: NonGoogleCoolifyDriver }>) { Object.freeze(this); }
  #key(operationId: string) { return `fault:${z.string().min(1).parse(operationId)}`; }
  async inject(input: Readonly<{ operationId: string; schedule: unknown }>): Promise<never> {
    const schedule = D122_FAULT_MATRIX.find(item => canonicalJson(item) === canonicalJson(input.schedule));
    if (!schedule) throw new Error("NON_GOOGLE_CHAOS_SCHEDULE_DENIED");
    const original: Original = Object.freeze({ version: 2, binding: this.input.binding, operationId: schedule.input.operationId, sessionId: schedule.initialState.sessionId, controlOperationId: z.string().min(1).parse(input.operationId), schedule, oracle: EffectOracleSchema.parse({ credit: 0, debit: 0, worker: 0, session: 0, artifact: 0, checkpoint: 0, deploy: 0, ownerEvent: 0, attestation: 0 }), state: "claimed" });
    await this.input.journal.claim(this.#key(original.operationId), hash(original), original);
    throw new Error("NON_GOOGLE_CHAOS_NATIVE_ACTUATOR_UNAVAILABLE");
  }
  async observe(input: Readonly<{ operationId: string; sessionId: string }>): Promise<never> {
    const operationId = z.string().min(1).parse(input.operationId), sessionId = z.string().min(1).parse(input.sessionId);
    const original = await this.input.journal.read<Original>(this.#key(operationId));
    if (!original || original.value.operationId !== operationId || original.value.sessionId !== sessionId) throw new Error("NON_GOOGLE_CHAOS_ORIGINAL_REQUIRED");
    FaultExecutionSchema.parse({ operationId, sessionId, observed: "unavailable", activeWriters: 1, effects: original.value.oracle });
    throw new Error("NON_GOOGLE_CHAOS_NATIVE_OBSERVATION_UNAVAILABLE");
  }
}
