import { z } from "zod";
import { MODAL_1_6_3_SDIST_SHA256, MODAL_1_6_3_VERSION, MODAL_1_6_3_WHEEL_SHA256 } from "../release/deployment/modal-billing-report";

const Digest = z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase());
const ObjectReference = z.object({ key: z.string().regex(/^modal-billing-preflight\/[A-Za-z0-9][A-Za-z0-9_.:/-]{1,511}$/u), generation: z.number().int().positive(), checksum: Digest }).strict();

/** Immutable controller-selected facts only. The sealed record may nominate
 * a future Modal report tool and preflight evidence object, but it cannot
 * assert entitlement, RBAC, currency, source-resource mapping, coverage, or
 * finality with booleans/digests supplied by the mount. */
export const MountedModalBillingConfigurationSchema = z.object({
  version: z.literal(1),
  cli: z.object({ version: z.literal(MODAL_1_6_3_VERSION), sdistSha256: z.literal(MODAL_1_6_3_SDIST_SHA256), wheelSha256: z.literal(MODAL_1_6_3_WHEEL_SHA256), executable: z.string().startsWith("/").max(4_096), executableSha256: Digest }).strict(),
  credentialReference: z.string().regex(/^secret\/[A-Za-z0-9][A-Za-z0-9_.:/-]{1,255}$/u), credentialReferenceSha256: Digest,
  preflightEvidence: ObjectReference,
}).strict();
export type MountedModalBillingConfiguration = Readonly<z.infer<typeof MountedModalBillingConfigurationSchema>>;

/** An authority-specific verifier will eventually consume this exact evidence
 * through a non-forgeable implementation. Parsing an artifact is deliberately
 * not verification: this contract has no `eligible: true` escape hatch. */
export const ModalBillingPreflightEvidenceSchema = z.object({
  version: z.literal(1),
  accountScopeSha256: Digest, environmentScopeSha256: Digest, credentialReferenceSha256: Digest,
  originalOperationRecordSha256: Digest, resourceIdentitySha256: Digest, currencyPolicySha256: Digest,
  reportCoveragePolicySha256: Digest, observedAtMs: z.number().int().positive(), expiresAtMs: z.number().int().positive(),
  verification: z.literal("external-authority-required"),
}).strict().superRefine((value, context) => {
  if (value.expiresAtMs <= value.observedAtMs) context.addIssue({ code: "custom", message: "MODAL_BILLING_PREFLIGHT_WINDOW_INVALID" });
});
export type ModalBillingPreflightEvidence = Readonly<z.infer<typeof ModalBillingPreflightEvidenceSchema>>;
export type ModalBillingPreflightEvidenceReader = Readonly<{
  /** Exact immutable bytes, not a list/latest lookup. A reader has no power
   * to turn evidence into a verified entitlement. */
  readExact(reference: z.infer<typeof ObjectReference>): Promise<Uint8Array | undefined>;
}>;

export type MountedModalBillingSelection = Readonly<{
  status: "disabled";
  code: "MODAL_BILLING_NOT_CONFIGURED" | "MODAL_BILLING_EXTERNAL_PREFLIGHT_REQUIRED" | "MODAL_BILLING_PREFLIGHT_UNREADABLE" | "MODAL_BILLING_PREFLIGHT_INVALID";
}>;

/** Normal mounted composition gate. It always disables collection today: the
 * public CLI report cannot prove Team/Enterprise eligibility, least-privilege
 * RBAC, original-operation-to-object binding, account currency, or complete
 * final coverage. Consequently no credential resolution or child process is
 * reachable through this selector, even if opaque evidence bytes parse. */
export async function selectMountedModalBilling(input: Readonly<{ configuration?: unknown; evidenceReader?: ModalBillingPreflightEvidenceReader }>): Promise<MountedModalBillingSelection> {
  if (input.configuration === undefined) return Object.freeze({ status: "disabled", code: "MODAL_BILLING_NOT_CONFIGURED" });
  const configuration = MountedModalBillingConfigurationSchema.safeParse(input.configuration);
  if (!configuration.success) return Object.freeze({ status: "disabled", code: "MODAL_BILLING_PREFLIGHT_INVALID" });
  if (!input.evidenceReader) return Object.freeze({ status: "disabled", code: "MODAL_BILLING_EXTERNAL_PREFLIGHT_REQUIRED" });
  const bytes = await input.evidenceReader.readExact(configuration.data.preflightEvidence).catch(() => undefined);
  if (!bytes) return Object.freeze({ status: "disabled", code: "MODAL_BILLING_PREFLIGHT_UNREADABLE" });
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return Object.freeze({ status: "disabled", code: "MODAL_BILLING_PREFLIGHT_INVALID" }); }
  const evidence = ModalBillingPreflightEvidenceSchema.safeParse(raw);
  if (!evidence.success || evidence.data.credentialReferenceSha256 !== configuration.data.credentialReferenceSha256) return Object.freeze({ status: "disabled", code: "MODAL_BILLING_PREFLIGHT_INVALID" });
  return Object.freeze({ status: "disabled", code: "MODAL_BILLING_EXTERNAL_PREFLIGHT_REQUIRED" });
}
