import { expect, test } from "bun:test";
import { createProductionCoreSuiteAdapters } from "../../src/release/deployment/production-core-suite-adapters";
import { CoreControlPayloadSchemas, CoreScheduledSampleSchema, CoreFreshInstanceSchema, CoreRestoreChunkSchema, CORE_RESTORE_CHUNK_BYTES } from "../../src/release/deployment/production-core-suite-protocol";
import { createWorkerBenchmarkSchedule } from "../../src/admission/benchmark";
import { IDENTICAL_WORKER_COHORT_PROFILE } from "../../src/certification/live/worker-ports";
import { D122_FAULT_MATRIX, DURABILITY_SUBJECT_KINDS } from "../../src/resilience/fault-harness";
import { runLiveRestoreCertification, type LiveRestorePort } from "../../src/certification/live/restore";
import { assertMountedFreshWorkspaceSubject } from "../../src/production/mounted-fresh-restore-runtime";
import { openRetainedSubject, sealRetainedSubject } from "../../src/production/retained-subject-archive";
import { DeterministicObjectStore } from "../../src/continuity/object-store";

const hash = "a".repeat(64);
const candidate = { id: hash, provider: "modal" as const, image: `registry/worker@sha256:${hash}`, sourceSha256: hash };
test("core suites cannot turn caller callbacks into real observations", () => {
  let calls = 0;
  const counterfeit = { async execute() { calls++; return { state: "completed", result: {} }; } };
  expect(() => createProductionCoreSuiteAdapters({ candidate, control: counterfeit as never, contextvm: { async generate() { calls++; } } as never })).toThrow("PRODUCTION_CORE_CONTROL_CLIENT_REQUIRED");
  expect(calls).toBe(0);
});

test("private cohort and fault controls accept only the locked schedules", () => {
  const schedule = createWorkerBenchmarkSchedule(IDENTICAL_WORKER_COHORT_PROFILE);
  expect(schedule).toHaveLength(1000);
  expect(schedule.slice(0, 200).every(item => item.cohort === "pool_hit")).toBe(true);
  expect(schedule.slice(200, 400).every(item => ["pool_miss", "cold", "contention"].includes(item.cohort))).toBe(true);
  for (const item of schedule) expect(CoreScheduledSampleSchema.safeParse({ id: item.id, cohort: item.cohort }).success).toBe(true);
  for (const invalid of [{ id: "benchmark-1001", cohort: "pool_hit" }, { id: "benchmark-1", cohort: "pool_miss" }, { id: "benchmark-1", cohort: "pool_hit", accepted: true }]) expect(CoreScheduledSampleSchema.safeParse(invalid).success).toBe(false);
  for (const schedule of D122_FAULT_MATRIX) expect(CoreControlPayloadSchemas["fault.inject"].safeParse({ schedule }).success).toBe(true);
  expect(CoreControlPayloadSchemas["fault.inject"].safeParse({ schedule: { ...D122_FAULT_MATRIX[0], replacement: true } }).success).toBe(false);
});

test("restore protocol rejects same-instance restore and unbounded chunk requests", () => {
  expect(CoreFreshInstanceSchema.safeParse({ freshInstanceId: "source", sourceInstanceId: "source", databaseInstanceId: "new-sql", applicationInstanceId: "new-app", restoredBackupSha256: hash }).success).toBe(false);
  expect(CoreFreshInstanceSchema.safeParse({ freshInstanceId: "new", sourceInstanceId: "source", databaseInstanceId: "source", applicationInstanceId: "new-app", restoredBackupSha256: hash }).success).toBe(false);
  expect(CoreRestoreChunkSchema.safeParse({ freshInstanceId: "new", sourceIdentity: "subject", offset: 0, totalBytes: 1, bytesBase64: "A".repeat(CORE_RESTORE_CHUNK_BYTES * 2) }).success).toBe(false);
});

test("mounted fresh recovery never coerces non-workspace subjects into checkpoint restores", () => {
  for (const kind of DURABILITY_SUBJECT_KINDS) {
    const subject = { kind, sourceIdentity: `${kind}:original`, object: { key: `retained/${kind}`, generation: 1, checksum: hash }, payloadSha256: hash, ownerId: "owner", retentionUntil: "2030-01-01T00:00:00.000Z", deletionState: "retained" as const };
    if (kind === "checkpoint") expect(() => assertMountedFreshWorkspaceSubject(subject)).not.toThrow();
    else expect(() => assertMountedFreshWorkspaceSubject(subject)).toThrow("MOUNTED_FRESH_RESTORE_SUBJECT_AUTHORITY_REQUIRED");
  }
});

test("each non-workspace retained subject uses distinct server custody while preserving its source identity", async () => {
  const entries = new Map<string, { keyReference: string; nonce: Uint8Array; ciphertext: Uint8Array; ciphertextSha256: string; aadSha256: string; retentionUntil: string; plaintext: Uint8Array; aad: Uint8Array }>();
  const digest = (value: Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
  const crypto = {
    async seal(input: { checkpointId: string; plaintext: Uint8Array; additionalData: Uint8Array; binding?: { retentionUntil: string } }) {
      const ciphertext = new Uint8Array(input.plaintext).reverse(), nonce = new Uint8Array(12).fill(7), keyReference = `key:${input.checkpointId}`;
      entries.set(input.checkpointId, { keyReference, nonce, ciphertext, ciphertextSha256: digest(ciphertext), aadSha256: digest(input.additionalData), retentionUntil: input.binding!.retentionUntil, plaintext: new Uint8Array(input.plaintext), aad: new Uint8Array(input.additionalData) });
      return { keyReference, nonce, ciphertext };
    },
    async open(input: { keyReference: string; nonce: Uint8Array; ciphertext: Uint8Array; additionalData: Uint8Array }) {
      const entry = [...entries.values()].find(value => value.keyReference === input.keyReference);
      if (!entry || digest(input.ciphertext) !== entry.ciphertextSha256 || digest(input.additionalData) !== entry.aadSha256) throw new Error("DENIED");
      return new Uint8Array(entry.plaintext);
    },
    async destroy() {},
    async readSealed(id: string) { const value = entries.get(id); return value && { keyReference: value.keyReference, nonce: new Uint8Array(value.nonce), ciphertext: new Uint8Array(value.ciphertext), ciphertextSha256: value.ciphertextSha256, aadSha256: value.aadSha256, retentionUntil: value.retentionUntil }; },
    async isDestroyed(keyReference: string) { return ![...entries.values()].some(value => value.keyReference === keyReference); },
  };
  const objects = new DeterministicObjectStore();
  const intents = new Map<string, { identitySha256: string; value: unknown }>();
  const journal = {
    async claim<T>(operationId: string, identitySha256: string, value: T) {
      const existing = intents.get(operationId);
      if (existing && existing.identitySha256 !== identitySha256) throw new Error("CONFLICT");
      if (!existing) intents.set(operationId, { identitySha256, value });
      const record = { operationId, identitySha256, revision: 1, value };
      return { claimed: !existing, record };
    },
    async read<T>(_operationId: string): Promise<undefined> { return undefined; },
  };
  for (const kind of DURABILITY_SUBJECT_KINDS.filter(kind => kind !== "checkpoint")) {
    const plain = new TextEncoder().encode(`${kind}:original-record`);
    const subject = await sealRetainedSubject({ crypto, objectStore: objects, journal, checkpointId: "checkpoint:one", accountId: "account:one", ownerId: "owner", sessionId: "session:one", actionId: "action:one", retentionUntil: "2030-01-01T00:00:00.000Z", source: { kind, sourceIdentity: `${kind}:source`, bytes: plain } });
    expect(subject.sourceIdentity).toBe(`${kind}:source`);
    expect(subject.object.key).toContain("durability-subject:");
    await expect(openRetainedSubject({ crypto, objectStore: objects, checkpointId: "checkpoint:one", accountId: "account:one", sessionId: "session:one", actionId: "action:one", subject })).resolves.toEqual(plain);
  }
  expect(entries.size).toBe(6);
});

test("a lost retained-object create acknowledgement never grants a second create", async () => {
  const objects = new DeterministicObjectStore();
  const source = new TextEncoder().encode("original-validation-bytes");
  let creates = 0, loseAck = true;
  const objectStore = {
    observeExactByKey: objects.observeExactByKey.bind(objects),
    readExact: objects.readExact.bind(objects),
    scheduleExactDeletion: objects.scheduleExactDeletion.bind(objects),
    async createImmutable(value: { key: string; bytes: Uint8Array }) {
      creates++;
      const reference = await objects.createImmutable(value);
      if (loseAck) { loseAck = false; throw new Error("CREATE_ACK_LOST"); }
      return reference;
    },
  };
  const ciphertext = new Uint8Array(source).reverse();
  let sealed: { aadSha256: string; retentionUntil: string } | undefined;
  const crypto = {
    async seal(input: { plaintext: Uint8Array; additionalData: Uint8Array; binding?: { retentionUntil: string } }) { sealed = { aadSha256: new Bun.CryptoHasher("sha256").update(input.additionalData).digest("hex"), retentionUntil: input.binding!.retentionUntil }; return { keyReference: "key:retained", nonce: new Uint8Array(12), ciphertext }; },
    async open() { return new Uint8Array(source); }, async destroy() {}, async isDestroyed() { return false; },
    async readSealed() { if (!sealed) return undefined; return { keyReference: "key:retained", nonce: new Uint8Array(12), ciphertext, ciphertextSha256: new Bun.CryptoHasher("sha256").update(ciphertext).digest("hex"), aadSha256: sealed.aadSha256, retentionUntil: sealed.retentionUntil }; },
  };
  const records = new Map<string, { identitySha256: string; value: unknown }>();
  const journal = { async claim<T>(operationId: string, identitySha256: string, value: T) { const prior = records.get(operationId); if (!prior) records.set(operationId, { identitySha256, value }); return { claimed: !prior, record: { operationId, identitySha256, revision: 1, value } }; }, async read<T>(_operationId: string): Promise<undefined> { return undefined; } };
  const request = { crypto, objectStore, journal, checkpointId: "checkpoint", accountId: "account", ownerId: "owner", sessionId: "session", actionId: "action", retentionUntil: "2030-01-01T00:00:00.000Z", source: { kind: "validation_evidence" as const, sourceIdentity: "validation:original", bytes: source } };
  await expect(sealRetainedSubject(request)).rejects.toThrow("CREATE_ACK_LOST");
  await expect(sealRetainedSubject(request)).resolves.toMatchObject({ kind: "validation_evidence" });
  expect(creates).toBe(1);
});

test("an expired retained-object reconciliation erases only its original uncertain custody", async () => {
  const objects = new DeterministicObjectStore();
  const source = new TextEncoder().encode("original-expiry-barrier-bytes");
  const deadline = Date.parse("2030-01-01T00:00:00.000Z");
  let now = deadline - 1, creates = 0, loseAck = true, advanceAfterObservation = false, destroyed = false;
  const ciphertext = new Uint8Array(source).reverse();
  const checksum = new Bun.CryptoHasher("sha256").update(ciphertext).digest("hex");
  let aadSha256 = "", retentionUntil = "";
  const crypto = {
    async seal(input: { plaintext: Uint8Array; additionalData: Uint8Array; binding?: { retentionUntil: string } }) {
      aadSha256 = new Bun.CryptoHasher("sha256").update(input.additionalData).digest("hex"); retentionUntil = input.binding!.retentionUntil;
      return { keyReference: "key:expiry", nonce: new Uint8Array(12), ciphertext };
    },
    async open() { return new Uint8Array(source); },
    async destroy() { destroyed = true; },
    async isDestroyed() { return destroyed; },
    async readSealed() { return { keyReference: "key:expiry", nonce: new Uint8Array(12), ciphertext, ciphertextSha256: checksum, aadSha256, retentionUntil }; },
  };
  const objectStore = {
    async createImmutable(value: { key: string; bytes: Uint8Array }) { creates++; const reference = await objects.createImmutable(value); if (loseAck) { loseAck = false; throw new Error("CREATE_ACK_LOST"); } return reference; },
    async observeExactByKey(value: { key: string; checksum: string }) { const observed = await objects.observeExactByKey(value); if (advanceAfterObservation) now = deadline; return observed; },
    readExact: objects.readExact.bind(objects), scheduleExactDeletion: objects.scheduleExactDeletion.bind(objects),
  };
  const records = new Map<string, { identitySha256: string; value: unknown }>();
  const journal = { async claim<T>(operationId: string, identitySha256: string, value: T) { const prior = records.get(operationId); if (!prior) records.set(operationId, { identitySha256, value }); return { claimed: !prior, record: { operationId, identitySha256, revision: 1, value } }; }, async read<T>(_operationId: string): Promise<undefined> { return undefined; } };
  const request = { crypto, objectStore, journal, checkpointId: "checkpoint", accountId: "account", ownerId: "owner", sessionId: "session", actionId: "action", retentionUntil: new Date(deadline).toISOString(), source: { kind: "validation_evidence" as const, sourceIdentity: "validation:expiry-original", bytes: source }, now: () => now };
  await expect(sealRetainedSubject(request)).rejects.toThrow("CREATE_ACK_LOST");
  advanceAfterObservation = true;
  await expect(sealRetainedSubject(request)).rejects.toThrow("RETAINED_SUBJECT_RETENTION_EXPIRED");
  expect(creates).toBe(1);
  expect(destroyed).toBe(true);
});

test("restore cleans the fresh instance after a failed subject and blocks unconfirmed cleanup", async () => {
  for (const cleanupFails of [false, true]) {
    let cleanups = 0;
    const port: LiveRestorePort = {
      // Test-only runner contract fixture; never exported as release evidence.
      evidenceClass: "protected_live",
      async inventory() { return DURABILITY_SUBJECT_KINDS.map(kind => ({ kind, sourceIdentity: kind, object: { key: kind, generation: 1, checksum: hash }, payloadSha256: hash, ownerId: "owner", retentionUntil: "2030-01-01T00:00:00.000Z", deletionState: "retained" })); },
      async loseLocalState() { return { status: "lost" }; },
      async createFreshInstance() { return {
        async restoreSubject() { throw new Error("CORRUPT_OR_MISSING_SUBJECT"); },
        async exerciseExpiryDeletion() { throw new Error("UNREACHED"); },
        async observeTopology() { throw new Error("UNREACHED"); },
        async cleanup() { cleanups++; if (cleanupFails) throw new Error("DELETE_OUTCOME_UNKNOWN"); },
      }; },
    };
    const result = await runLiveRestoreCertification({ candidate, topology: {}, restorePort: port });
    expect(result.status).toBe("blocked");
    expect(result.claims).toEqual([]);
    expect(cleanups).toBe(1);
    expect(result.limitations).toEqual([cleanupFails ? "restore-cleanup-unconfirmed" : "restore-observation-unavailable"]);
  }
});
