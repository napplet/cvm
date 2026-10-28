import { z } from "zod";

const sha = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
export const ProductionConformanceReceiptSchema = z.object({
  path: z.literal("test-results/conformance.json"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytesBase64: z.string().min(1).max(349_528),
}).strict().superRefine((value, context) => {
  const bytes = Buffer.from(value.bytesBase64, "base64");
  if (!bytes.length || bytes.length > 262_144 || bytes.toString("base64") !== value.bytesBase64 || sha(bytes) !== value.sha256) context.addIssue({ code: "custom", message: "CONFORMANCE_RECEIPT_BYTES_INVALID" });
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { context.addIssue({ code: "custom", message: "CONFORMANCE_RECEIPT_ENCODING_INVALID" }); }
});
export type ProductionConformanceReceipt = z.infer<typeof ProductionConformanceReceiptSchema>;

const Count = z.number().int().min(0).max(128);
const Check = z.object({ id: z.string().min(1).max(128), area: z.string().min(1).max(64), severity: z.enum(["error", "warning"]), title: z.string().min(1).max(512), status: z.enum(["pass", "fail", "skip"]), detail: z.string().max(16_384).optional() }).strict();
const Report = z.object({ startedAt: z.number().int().nonnegative(), finishedAt: z.number().int().nonnegative(), checks: z.array(Check).min(1).max(128), summary: z.object({ total: Count, passed: Count, failed: Count, skipped: Count, errors: Count, warnings: Count }).strict(), ok: z.boolean() }).strict();
const REQUIRED = ["boot/sandbox-allow-scripts", "boot/installs-global", "boot/no-boot-error", "boot/no-forbidden-globals", "wire/envelope-well-formed", "degrade/domain-absence"] as const;
const UNSIGNED_OR_UNMEASURED = new Set(["manifest/event-kind", "manifest/index-html", "manifest/requires", "manifest/requires-known", "lifecycle/clean-teardown"]);

/** Validate the actual standalone report; manifest/owner checks and full host
 * teardown remain separate gates. Summary/ok cannot replace required checks. */
export function verifyProductionConformanceReceipt(input: unknown) {
  const receipt = ProductionConformanceReceiptSchema.parse(input);
  const report = Report.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(receipt.bytesBase64, "base64"))));
  const counts = { total: report.checks.length, passed: report.checks.filter(check => check.status === "pass").length, failed: report.checks.filter(check => check.status === "fail").length, skipped: report.checks.filter(check => check.status === "skip").length, errors: report.checks.filter(check => check.status === "fail" && check.severity === "error").length, warnings: report.checks.filter(check => check.status === "fail" && check.severity === "warning").length };
  if (report.finishedAt < report.startedAt || new Set(report.checks.map(check => check.id)).size !== report.checks.length || Object.entries(counts).some(([key, value]) => report.summary[key as keyof typeof counts] !== value) || !report.ok || counts.failed !== 0 || REQUIRED.some(id => !report.checks.some(check => check.id === id && check.severity === "error" && check.status === "pass")) || report.checks.some(check => check.status === "skip" && !UNSIGNED_OR_UNMEASURED.has(check.id))) throw new Error("PRODUCTION_DIRECT_CONFORMANCE_REJECTED");
  return Object.freeze({ receipt, report });
}
