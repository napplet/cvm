import { z } from "zod";

/** Root-supervisor observation of the actual protected authoring file. Absence
 * is evidence about this file, not about capability availability. */
export const ProductionCapabilityReceiptSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("absent"), path: z.literal("src/capabilities.json") }).strict(),
  z.object({ state: z.literal("present"), path: z.literal("src/capabilities.json"), sha256: z.string().regex(/^[a-f0-9]{64}$/u), bytesBase64: z.string().min(1).max(40_000) }).strict(),
]).superRefine((receipt, context) => {
  if (receipt.state === "absent") return;
  const bytes = Buffer.from(receipt.bytesBase64, "base64");
  if (bytes.length < 1 || bytes.length > 30_000 || bytes.toString("base64") !== receipt.bytesBase64 || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== receipt.sha256) context.addIssue({ code: "custom", message: "CAPABILITY_RECEIPT_BYTES_INVALID" });
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { context.addIssue({ code: "custom", message: "CAPABILITY_RECEIPT_ENCODING_INVALID" }); }
});
export type ProductionCapabilityReceipt = z.infer<typeof ProductionCapabilityReceiptSchema>;
