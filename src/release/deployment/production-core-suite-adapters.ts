import { z } from "zod";
import type { LiveRestorePort } from "../../certification/live/restore";
import { canonicalJson } from "../../promotion/schema";
import { WorkerCandidateSchema, type WorkerCandidate } from "../../certification/contracts";
import { WorkerBenchmarkSampleSchema } from "../../admission/benchmark";
import { executeIdenticalWorkerCohorts } from "../../certification/live/worker-ports";
import type { ProductionLiveProtectedCertificationPorts } from "../../certification/live/production-ports";
import { validateDurabilityInventory, RestoreDrillInputSchema, type RestoreDrillInput } from "../../resilience/fault-harness";
import { assertContextVmCertificationClient, type ContextVmCertificationClient } from "./contextvm-client";
import { assertProductionCoreControlClient, type CoreControlKind, type ProductionCoreControlClient } from "./production-core-control";
import { CORE_RESTORE_CHUNK_BYTES, CORE_RESTORE_MAX_BYTES, CoreControlPayloadSchemas, CoreScheduledSampleSchema, CoreFreshInstanceSchema, CoreRestoreDescriptorSchema, CoreRestoreChunkSchema, type CoreServiceControlKind } from "./production-core-suite-protocol";
import { assertProductionNativeCoreCertificationServices, type ProductionNativeCoreCertificationServices } from "../../production/certification-services";

export type ProductionCoreSuiteAdapters = Pick<ProductionLiveProtectedCertificationPorts, "admission" | "telemetry" | "chaos" | "durability">;
const digest = (value: unknown) => new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex");
const byteDigest = (value: Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Identity = z.string().min(1).max(256);
const AdmissionPrepared = z.object({ requestedCap: z.string().regex(/^[1-9][0-9]*$/u) }).strict();
const AdmissionObserved = z.object({ candidateId: Digest, provider: z.enum(["modal", "fly"]), sample: WorkerBenchmarkSampleSchema, correlation: z.object({ clientOperationId: Identity, admissionReference: Identity, requestEventId: Digest }).strict() }).strict();
type Input = Readonly<{ candidate: WorkerCandidate; control: ProductionCoreControlClient; contextvm: ContextVmCertificationClient }>;
type NativeInput = Readonly<{ candidate: WorkerCandidate; services: ProductionNativeCoreCertificationServices; contextvm?: ContextVmCertificationClient }>;
type AdapterInput = Readonly<{ candidate: WorkerCandidate; contextvm: ContextVmCertificationClient; control: (kind: CoreServiceControlKind, payload: unknown) => Promise<unknown> }>;

/** All effects are concrete receipt-gated private control or signed ContextVM
 * operations. No callback can supply a benchmark, collector, or restore result.
 * Construction is pure. The server retains the operation's raw observations. */
function createCoreSuiteAdapters(input: AdapterInput): ProductionCoreSuiteAdapters {
  const candidate = WorkerCandidateSchema.parse(input.candidate);
  assertContextVmCertificationClient(input.contextvm);
  async function control(kind: CoreServiceControlKind, payload: unknown): Promise<unknown> {
    return input.control(kind, payload);
  }
  const admission: ProductionCoreSuiteAdapters["admission"] = Object.freeze({
    evidenceClass: "real" as const,
    async executeSample(value) {
      const sample = CoreScheduledSampleSchema.parse(value);
      const payload = { candidateId: candidate.id, provider: candidate.provider, sample };
      const prepared = AdmissionPrepared.parse(await control("cohort.prepare", payload));
      const operationId = `admission-${candidate.provider}-${sample.id}`;
      // The actual signed response may be lost. Its durable original claim
      // permits only a private query of that exact server-side invocation.
      try { await input.contextvm.admit({ operationId, candidateId: candidate.id, ...prepared }); }
      catch { /* The authoritative query below must prove the outcome. */ }
      const observed = AdmissionObserved.parse(await control("cohort.observe", payload));
      if (observed.candidateId !== candidate.id || observed.provider !== candidate.provider || observed.correlation.clientOperationId !== operationId || observed.sample.id !== sample.id || observed.sample.cohort !== sample.cohort) throw new Error("CORE_SUITE_ADMISSION_BINDING_INVALID");
      if (observed.sample.readyMonotonicMs !== null && observed.sample.readyMonotonicMs < observed.sample.receiptMonotonicMs) throw new Error("CORE_SUITE_ADMISSION_CLOCK_INVALID");
      return observed.sample;
    },
  });
  const telemetry: ProductionCoreSuiteAdapters["telemetry"] = Object.freeze({
    evidenceClass: "real" as const,
    async emit(observation) { await control("telemetry.emit", { observation }); },
    queryWindow: binding => control("telemetry.window", CoreControlPayloadSchemas["telemetry.window"].parse({ binding })),
  });
  const chaos: ProductionCoreSuiteAdapters["chaos"] = Object.freeze({
    evidenceClass: "real" as const,
    executeFault: schedule => control("fault.inject", { schedule }),
    observeOriginal: identity => control("fault.observe", identity),
    observeTopology: () => control("restore.topology", {}),
  });
  const durability: ProductionCoreSuiteAdapters["durability"] = Object.freeze({
    evidenceClass: "real" as const,
    async inventory() {
      // The archive/registry materialization is a separately journaled,
      // receipt-bound control effect. `restore.inventory` below only reads it.
      await control("restore.prepare", {});
      return validateDurabilityInventory(await control("restore.inventory", {}));
    },
    loseLocalState: () => control("restore.lose-local", {}),
    async createFreshInstance() {
      const fresh = CoreFreshInstanceSchema.parse(await control("restore.create", {}));
      let remainingBytes = CORE_RESTORE_MAX_BYTES;
      return Object.freeze({
        async restoreSubject(subject: Parameters<Awaited<ReturnType<LiveRestorePort["createFreshInstance"]>>["restoreSubject"]>[0]) {
          const base = { freshInstanceId: fresh.freshInstanceId, subject };
          const descriptor = CoreRestoreDescriptorSchema.parse(await control("restore.subject", { ...base, action: "describe" }));
          if (descriptor.freshInstanceId !== fresh.freshInstanceId || canonicalJson(descriptor.subject) !== canonicalJson(subject)) throw new Error("CORE_SUITE_RESTORE_SUBJECT_CHANGED");
          async function read(action: "read-ciphertext" | "read-plaintext"): Promise<Uint8Array> {
            const parts: Uint8Array[] = []; let total = 0, expectedTotal: number | undefined;
            do {
              const chunk = CoreRestoreChunkSchema.parse(await control("restore.subject", { ...base, action, offset: total }));
              const bytes = new Uint8Array(Buffer.from(chunk.bytesBase64, "base64"));
              if (Buffer.from(bytes).toString("base64") !== chunk.bytesBase64 || chunk.freshInstanceId !== fresh.freshInstanceId || chunk.sourceIdentity !== subject.sourceIdentity || chunk.offset !== total || (expectedTotal !== undefined && chunk.totalBytes !== expectedTotal) || bytes.length !== Math.min(CORE_RESTORE_CHUNK_BYTES, chunk.totalBytes - total) || chunk.totalBytes > remainingBytes) throw new Error("CORE_SUITE_RESTORE_CHUNK_INVALID");
              expectedTotal = chunk.totalBytes; parts.push(bytes); total += bytes.length;
            } while (total < expectedTotal!);
            remainingBytes -= total;
            return new Uint8Array(Buffer.concat(parts));
          }
          let verifiedArchive: Uint8Array | undefined;
          const objectStore = Object.freeze({
            async createImmutable(): Promise<never> { throw new Error("CORE_SUITE_RESTORE_READ_ONLY"); },
            async scheduleExactDeletion(): Promise<never> { throw new Error("CORE_SUITE_RESTORE_READ_ONLY"); },
            async observeExactByKey(reference: Readonly<{ key: string; checksum: string }>) {
              if (reference.key !== subject.object.key || reference.checksum !== subject.object.checksum) throw new Error("CORE_SUITE_RESTORE_OBJECT_CHANGED");
              if (byteDigest(await read("read-ciphertext")) !== subject.object.checksum) throw new Error("CORE_SUITE_RESTORE_CIPHERTEXT_INVALID");
              return subject.object;
            },
            async readExact(reference: unknown) {
              if (canonicalJson(reference) !== canonicalJson(subject.object)) throw new Error("CORE_SUITE_RESTORE_OBJECT_CHANGED");
              return read("read-ciphertext");
            },
          });
          const decryptAndVerify: RestoreDrillInput["decryptAndVerify"] = async bytes => {
            const ciphertextSha256 = byteDigest(bytes);
            if (ciphertextSha256 !== subject.object.checksum) throw new Error("CORE_SUITE_RESTORE_CIPHERTEXT_INVALID");
            const result = z.object({ freshInstanceId: Identity, sourceIdentity: Identity, ciphertextSha256: Digest, archiveSha256: Digest, expected: RestoreDrillInputSchema.shape.expected }).strict().parse(await control("restore.subject", { ...base, action: "decrypt", ciphertextSha256 }));
            if (result.freshInstanceId !== fresh.freshInstanceId || result.sourceIdentity !== subject.sourceIdentity || result.ciphertextSha256 !== ciphertextSha256 || result.archiveSha256 !== subject.payloadSha256 || canonicalJson(result.expected) !== canonicalJson(descriptor.expected)) throw new Error("CORE_SUITE_RESTORE_DECRYPT_BINDING_INVALID");
            verifiedArchive = await read("read-plaintext");
            if (byteDigest(verifiedArchive) !== subject.payloadSha256) throw new Error("CORE_SUITE_RESTORE_ARCHIVE_INVALID");
            return { ...result.expected, archive: new Uint8Array(verifiedArchive) };
          };
          const reattach: RestoreDrillInput["reattach"] = async value => {
            if (!verifiedArchive || value.sourceIdentity !== subject.sourceIdentity || canonicalJson(value.object) !== canonicalJson(subject.object) || canonicalJson(value.expected) !== canonicalJson(descriptor.expected) || byteDigest(value.archive) !== subject.payloadSha256) throw new Error("CORE_SUITE_RESTORE_REATTACH_BINDING_INVALID");
            try { return z.object({ status: z.enum(["reattached", "replayed", "reconciliation_pending"]), workerId: Identity.optional() }).strict().parse(await control("restore.subject", { ...base, action: "reattach", archiveSha256: subject.payloadSha256, expected: descriptor.expected })); }
            finally { verifiedArchive.fill(0); verifiedArchive = undefined; }
          };
          return Object.freeze({ objectStore, expected: descriptor.expected, decryptAndVerify, reattach });
        },
        exerciseExpiryDeletion: () => control("restore.expiry", { freshInstanceId: fresh.freshInstanceId }),
        observeTopology: () => control("restore.topology", { freshInstanceId: fresh.freshInstanceId }),
        async cleanup() {
          z.object({ state: z.literal("absent"), freshInstanceId: z.literal(fresh.freshInstanceId) }).strict().parse(await control("restore.cleanup", { freshInstanceId: fresh.freshInstanceId }));
        },
      });
    },
  });
  return Object.freeze({ admission, telemetry, chaos, durability });
}

/** Historical private-control transport retained for legacy read/cleanup
 * callers only. The non-Google successor uses the native constructor below. */
export function createProductionCoreSuiteAdapters(input: Input): ProductionCoreSuiteAdapters {
  const candidate = WorkerCandidateSchema.parse(input.candidate);
  assertProductionCoreControlClient(input.control);
  return createCoreSuiteAdapters({ candidate, contextvm: input.contextvm, async control(kind, payload) {
    const operationId = `core:${candidate.provider}:${kind.replaceAll(".", "-")}:${digest(payload)}`;
    let result = await input.control.execute({ operationId, kind, payload });
    if (result.state === "unknown" || result.state === "pending") result = await input.control.observe({ operationId, kind, requestSha256: result.requestSha256 });
    if (result.state !== "completed" || result.result === undefined) throw new Error("CORE_SUITE_ORIGINAL_OPERATION_PENDING");
    return result.result;
  } });
}

/**
 * Successor adapter composition is direct: every command is dispatched to a
 * branded project-owned backend service and uncertain outcomes are reconciled
 * against that same original operation. It never accepts an HTTP descriptor,
 * caller result, or self-declared `real` label as evidence.
 */
export function createNativeProductionCoreSuiteAdapters(input: NativeInput): ProductionCoreSuiteAdapters {
  const candidate = WorkerCandidateSchema.parse(input.candidate);
  assertProductionNativeCoreCertificationServices(input.services);
  if (!input.contextvm) throw new Error("PRODUCTION_CORE_NATIVE_CONTEXTVM_REQUIRED");
  return createCoreSuiteAdapters({ candidate, contextvm: input.contextvm, async control(kind, payload) {
    const operationId = `core:${candidate.provider}:${kind.replaceAll(".", "-")}:${digest(payload)}`;
    return input.services.execute({ operationId, kind, payload });
  } });
}

/** Both providers run the immutable schedule. Reuse observes original samples;
 * it cannot buy a replacement cohort after an unfavorable observation. */
export async function selectProductionWorkerFromCohorts(input: Readonly<{ candidates: readonly [Input & { topologySha256: string }, Input & { topologySha256: string }]; observedAtMs: number; expiresAtMs: number }>) {
  return executeIdenticalWorkerCohorts({ observedAtMs: input.observedAtMs, expiresAtMs: input.expiresAtMs, candidates: input.candidates.map(value => ({ candidate: value.candidate, topologySha256: value.topologySha256, observationPort: { ...createProductionCoreSuiteAdapters(value).admission, evidenceClass: "protected_live" as const } })) });
}
