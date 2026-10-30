import { z } from "zod";

/** Measured bytes from fixed immutable image paths, not generated project
 * metadata. These pins correspond to the separately reproduced 0.13 recipe. */
export const DIRECT_CLI_BINARY_SHA256 = Object.freeze({
  "linux-x64": "5fbc61d2a4be189094726c7b7d7f073a00c122d93cedfa3bd37b7571fb430d08",
  "linux-arm64": "2a78a97ae95f493a0c568366ede5a53ce99808fa2fe487572952b7f4f9770a26",
});
export const ProductionDirectToolchainReceiptSchema = z.object({ version: z.literal(1), artifactContract: z.literal("nip5d-direct-v1"),
  platform: z.enum(["linux-x64", "linux-arm64"]), cliBinarySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  workerPackageSha256: z.literal("ca0d5a088c7650407306899eaaaa535b2bd872d746d7aee10be471894944abbf"),
  workerLockSha256: z.literal("f0ac025b6f79609a159702adedfbfebd8966b1c65f78cf1e0f75912ae54a567d"),
  templatePackageSha256: z.literal("81f03e8b76b15cbc025b11a67117389b579ee1ca374ddb680971f91e7293a99f"),
  templateLockSha256: z.literal("ec1eb261c06641decda0c8fbd3a96e5f121cddfcc6abdc8888f78556390e28e4"),
}).strict().refine(value => value.cliBinarySha256 === DIRECT_CLI_BINARY_SHA256[value.platform], "DIRECT_TOOLCHAIN_BINARY_IDENTITY_MISMATCH");

/** Historical direct artifacts may omit this additive receipt. A protected
 * source gate must require it explicitly, rather than infer measured bytes. */
export function requireDirectToolchainReceipt(value: unknown) {
  if (value === undefined) throw new Error("DIRECT_TOOLCHAIN_MEASURED_RECEIPT_REQUIRED");
  return ProductionDirectToolchainReceiptSchema.parse(value);
}
