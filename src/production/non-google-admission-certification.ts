import { createHash } from "node:crypto";
import { z } from "zod";
import { CoreControlPayloadSchemas } from "../release/deployment/production-core-suite-protocol";
import type { NonGoogleCoreBinding } from "./non-google-native-runtime";
import { NonGoogleCoreJournal, NonGoogleNativeCapacity } from "./non-google-native-runtime";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Prepared = Readonly<{ version: 1; binding: NonGoogleCoreBinding; operationId: string; controlOperationId: string; candidateId: string; provider: "modal" | "fly"; sample: Readonly<{ id: string; cohort: string }>; intentReference: string; bindingDigest: string; state: "claimed" | "reserved"; reference?: string }>;

/** Candidate-bound admission uses the locked scheduled-sample identity as its
 * domain operation. A control command is merely correlated with that original;
 * it can never replace it after an acknowledgement is lost. */
export class NonGoogleAdmissionCertification {
  constructor(private readonly input: Readonly<{ binding: NonGoogleCoreBinding; journal: NonGoogleCoreJournal; capacity: NonGoogleNativeCapacity }>) { Object.freeze(this); }
  #domain(provider: "modal" | "fly", sample: Readonly<{ id: string; cohort: string }>) { return `admission:${provider}:${sample.id}`; }
  async prepare(input: Readonly<{ operationId: string; candidateId: string; provider: "modal" | "fly"; sample: unknown }>): Promise<Readonly<{ requestedCap: "1"; operationId: string }>> {
    const parsed = CoreControlPayloadSchemas["cohort.prepare"].parse({ candidateId: input.candidateId, provider: input.provider, sample: input.sample });
    if (parsed.candidateId !== this.input.binding.candidateSha256) throw new Error("NON_GOOGLE_ADMISSION_CANDIDATE_DENIED");
    const operationId = this.#domain(parsed.provider, parsed.sample);
    const intentReference = `non-google-capacity:${hash({ binding: this.input.binding, operationId })}`;
    const bindingDigest = `sha256:${hash({ operationId, candidateId: parsed.candidateId, provider: parsed.provider, sample: parsed.sample })}`;
    const original: Prepared = Object.freeze({ version: 1, binding: this.input.binding, operationId, controlOperationId: z.string().min(1).parse(input.operationId), candidateId: parsed.candidateId, provider: parsed.provider, sample: parsed.sample, intentReference, bindingDigest, state: "claimed" });
    const claim = await this.input.journal.claim(operationId, hash(original), original);
    const persisted = claim.record.value;
    if (persisted.controlOperationId !== original.controlOperationId && persisted.state === "claimed") throw new Error("NON_GOOGLE_ADMISSION_CONTROL_CORRELATION_DENIED");
    if (persisted.state === "claimed") {
      const capacity = await this.input.capacity.reserve({ intentReference: persisted.intentReference, expectedSessionBindingDigest: persisted.bindingDigest });
      if (capacity.status !== "available" || !capacity.reference || !capacity.ready || capacity.ready.intentReference !== persisted.intentReference || capacity.ready.sessionBindingDigest !== persisted.bindingDigest) throw new Error("NON_GOOGLE_ADMISSION_CAPACITY_UNAVAILABLE");
      const reserved = Object.freeze({ ...persisted, state: "reserved" as const, reference: capacity.reference });
      if (!await this.input.journal.replace(operationId, claim.record.identitySha256, claim.record.revision, reserved)) throw new Error("NON_GOOGLE_ADMISSION_RESERVATION_CONFLICT");
    }
    return Object.freeze({ requestedCap: "1" as const, operationId });
  }
  async observe(input: Readonly<{ operationId: string; candidateId: string; provider: "modal" | "fly"; sample: unknown }>): Promise<Readonly<{ candidateId: string; provider: "modal" | "fly"; sample: Readonly<{ id: string; cohort: string }>; operationId: string; capacityReference: string }>> {
    const parsed = CoreControlPayloadSchemas["cohort.observe"].parse({ candidateId: input.candidateId, provider: input.provider, sample: input.sample });
    const operationId = this.#domain(parsed.provider, parsed.sample); const original = await this.input.journal.read<Prepared>(operationId);
    if (!original || original.value.state !== "reserved" || original.value.candidateId !== parsed.candidateId || original.value.provider !== parsed.provider || original.value.sample.id !== parsed.sample.id || original.value.sample.cohort !== parsed.sample.cohort || !original.value.reference) throw new Error("NON_GOOGLE_ADMISSION_ORIGINAL_REQUIRED");
    const observed = await this.input.capacity.observe({ intentReference: original.value.intentReference, expectedSessionBindingDigest: original.value.bindingDigest, reference: original.value.reference });
    if (observed.status !== "available" || observed.reference !== original.value.reference || !observed.ready || observed.ready.intentReference !== original.value.intentReference || observed.ready.sessionBindingDigest !== original.value.bindingDigest) throw new Error("NON_GOOGLE_ADMISSION_OBSERVATION_PENDING");
    return Object.freeze({ candidateId: original.value.candidateId, provider: original.value.provider, sample: original.value.sample, operationId, capacityReference: original.value.reference });
  }
}
