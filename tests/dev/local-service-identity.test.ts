import { expect, test } from "bun:test";
import { PrivateKeySigner } from "@contextvm/sdk/signer";
import { developmentServiceIdentity } from "../../src/dev/local-service-identity";

test("development service identity survives recreation with separate signing and MAC keys", async () => {
  const seed = "17".repeat(32);
  const first = developmentServiceIdentity(seed);
  const restarted = developmentServiceIdentity(seed);
  expect(await new PrivateKeySigner(first.signerPrivateKey).getPublicKey()).toBe(await new PrivateKeySigner(restarted.signerPrivateKey).getPublicKey());
  expect(first.admissionSecret).toEqual(restarted.admissionSecret);
  expect(first.cursorSecret).toEqual(restarted.cursorSecret);
  const values = [seed, first.signerPrivateKey, Buffer.from(first.admissionSecret).toString("hex"), Buffer.from(first.cursorSecret).toString("hex")];
  expect(new Set(values).size).toBe(4);
  first.admissionSecret.fill(0);
  first.cursorSecret.fill(0);
  expect(developmentServiceIdentity(seed).admissionSecret).toEqual(restarted.admissionSecret);
  expect(developmentServiceIdentity(seed).cursorSecret).toEqual(restarted.cursorSecret);
  const reset = developmentServiceIdentity("29".repeat(32));
  expect(await new PrivateKeySigner(reset.signerPrivateKey).getPublicKey()).not.toBe(await new PrivateKeySigner(restarted.signerPrivateKey).getPublicKey());
});

test("invalid development seed fails without echoing secret input", () => {
  for (const seed of ["", "private-invalid-value", "1".repeat(63), "G".repeat(64), "f".repeat(65)]) {
    expect(() => developmentServiceIdentity(seed)).toThrow("DEV_SERVICE_IDENTITY_SEED_INVALID");
  }
});
