import { expect, test } from "bun:test";
import { InMemoryProtectedRailMaterialRepository, ProtectedRailMaterialVault, type ProtectedRailMaterialRecord } from "../../src/funding/protected-rail-material";

const metadata = { accountId: "account:fixture", topUpId: "topup:fixture", rail: "cashu" as const };
const key = () => new Uint8Array(32).fill(3);
function padded(value: Uint8Array): Uint8Array { const full = new Uint8Array(value.length + 12).fill(99); full.set(value, 5); return full.subarray(5, 5 + value.length); }

test("seal snapshots caller bytes before awaiting so receipt digest and ciphertext describe the same payload", async () => {
  const repository = new InMemoryProtectedRailMaterialRepository();
  const vault = new ProtectedRailMaterialVault({ key: key(), repository });
  const original = new TextEncoder().encode("synthetic original proof material");
  const plaintext = padded(original);
  const sealing = vault.seal(metadata, plaintext);
  plaintext.fill(1);
  const reference = await sealing;
  expect(await vault.open({ ...metadata, id: reference.id })).toEqual(original);
  expect(reference.payloadDigest).toBe(new Bun.CryptoHasher("sha256").update(original).digest("hex"));
  expect(plaintext).toEqual(new Uint8Array(original.length).fill(1));
});

test("owned crypto inputs preserve sliced key, nonce, plaintext and repository record boundaries", async () => {
  const repository = new InMemoryProtectedRailMaterialRepository();
  const originalKey = padded(key());
  const vault = new ProtectedRailMaterialVault({ key: originalKey, repository, randomValues: bytes => padded(bytes.fill(4)) });
  originalKey.fill(0);
  const plaintext = padded(new TextEncoder().encode("only these proof bytes"));
  const reference = await vault.seal(metadata, plaintext);
  const record = repository.snapshot()[0];
  if (!record) throw new Error("FIXTURE_RECORD_REQUIRED");
  const reader = new ProtectedRailMaterialVault({ key: key(), repository: { put: async () => { throw new Error("READ_ONLY_FIXTURE"); }, expire: async () => { throw new Error("READ_ONLY_FIXTURE"); }, get: async () => ({ ...record, nonce: padded(record.nonce), ciphertext: padded(record.ciphertext) }) } });
  expect(await reader.open({ ...metadata, id: reference.id })).toEqual(plaintext);
  await expect(reader.open({ ...metadata, accountId: "account:foreign", id: reference.id })).rejects.toThrow("PROTECTED_MATERIAL_ACCESS_DENIED");
  expect(repository.snapshot()).toHaveLength(1);
});

test("the owned-buffer reader opens the exact legacy record generated at mainline 6d2283b", async () => {
  const record: ProtectedRailMaterialRecord = { ...metadata, id: "railmat:9f960619b0a5b656cde4b95d:BAQEBAQEBAQEBAQE", payloadDigest: "9f960619b0a5b656cde4b95dc8ff2cf73333b4f1590a3f4acc9d19e8112279b3", nonce: new Uint8Array(Buffer.from("BAQEBAQEBAQEBAQE", "base64")), ciphertext: new Uint8Array(Buffer.from("LEJ0rM7nJ23gevQ2FCBQE7EM/QMspWePSRxi40rvhQEB8eE8u2rB5YcXt8NgEHw=", "base64")), createdAt: "2026-08-04T00:00:00.000Z" };
  const repository = new InMemoryProtectedRailMaterialRepository();
  await repository.put(record);
  const vault = new ProtectedRailMaterialVault({ key: key(), repository });
  expect(new TextDecoder().decode(await vault.open({ ...metadata, id: record.id }))).toBe("legacy synthetic proof material");
  expect(repository.snapshot()[0]).toEqual(record);
  const compatible = new ProtectedRailMaterialVault({ key: key(), repository, randomValues: bytes => bytes.fill(4), now: () => record.createdAt });
  expect(await compatible.seal(metadata, new TextEncoder().encode("legacy synthetic proof material"))).toEqual({ id: record.id, payloadDigest: record.payloadDigest });
  expect(repository.snapshot()[0]).toEqual(record);
  record.ciphertext[0] = record.ciphertext[0]! ^ 1;
  await repository.put(record);
  await expect(vault.open({ ...metadata, id: record.id })).rejects.toThrow("PROTECTED_MATERIAL_ACCESS_DENIED");
});
