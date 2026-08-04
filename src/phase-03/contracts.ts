import { z } from "zod";

const DecimalSatSchema = z.string().regex(/^[1-9][0-9]*$/u, "must be a positive canonical integer string").refine(
  (value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
  "must be within the explicitly supported safe-integer sat limit",
);

const NonNegativeDecimalSatSchema = z.string().regex(/^(0|[1-9][0-9]*)$/u, "must be a canonical non-negative integer string").refine(
  (value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
  "must be within the explicitly supported safe-integer sat limit",
);

export const PrincipalSchema = z.object({
  pubkey: z.string().regex(/^[a-f0-9]{64}$/u, "pubkey must be a canonical lowercase 32-byte hex value"),
}).strict();

export const VerifiedSettlementSchema = z.object({
  topUpId: z.string().min(1),
  rail: z.enum(["lightning", "cashu"]),
  unit: z.literal("sat"),
  amount: DecimalSatSchema,
  externalReference: z.string().min(1),
  settlementReference: z.string().min(1),
  verifiedAt: z.iso.datetime(),
}).strict();

export const ReadyCapacityFactSchema = z.object({
  reference: z.string().min(1),
  usable: z.boolean(),
}).strict();

const CommandBaseSchema = z.object({
  principal: PrincipalSchema,
  idempotencyKey: z.string().min(1),
  policyVersion: z.string().min(1),
  protocolVersion: z.string().min(1),
});

export const CreditSettlementCommandSchema = CommandBaseSchema.extend({
  kind: z.literal("credit_settlement"),
  payload: z.object({ settlement: VerifiedSettlementSchema }).strict(),
}).strict();

export const FundedAdmissionCommandSchema = CommandBaseSchema.extend({
  kind: z.literal("funded_admission"),
  payload: z.object({
    requestedCap: DecimalSatSchema,
    unit: z.literal("sat"),
    capacity: ReadyCapacityFactSchema,
  }).strict(),
}).strict();

/** Sole public command authority for the Phase 3 transport-neutral funding core. */
export const AuthenticatedFundingCommandSchema = z.discriminatedUnion("kind", [
  CreditSettlementCommandSchema,
  FundedAdmissionCommandSchema,
]);

export const AccountTopUpStatusSchema = z.object({
  topUpId: z.string().min(1), state: z.enum(["pending", "verifying", "settled", "credited", "failed", "reconciliation_pending"]),
  amount: DecimalSatSchema, unit: z.literal("sat"), rail: z.enum(["lightning", "cashu"]), createdAt: z.iso.datetime(),
  safeDisplayReference: z.string().min(1).optional(), expiresAt: z.iso.datetime().optional(), verifiedAt: z.iso.datetime().optional(), settlementReference: z.string().min(1).optional(),
}).strict();

export const AccountStatusSchema = z.object({
  accountId: z.string().min(1),
  unit: z.literal("sat"),
  available: NonNegativeDecimalSatSchema,
  held: NonNegativeDecimalSatSchema,
  topUps: z.array(AccountTopUpStatusSchema),
  admissions: z.array(z.object({ reference: z.string().min(1), approvedCap: DecimalSatSchema, heldAmount: DecimalSatSchema, unit: z.literal("sat") }).strict()),
}).strict();

export const FundedAdmissionSchema = z.object({
  status: z.literal("accepted"), accountId: z.string().min(1), reference: z.string().min(1), approvedCap: DecimalSatSchema, heldAmount: DecimalSatSchema, unit: z.literal("sat"),
}).strict();

export const CreditedSettlementResultSchema = z.object({
  status: z.literal("credited"), accountId: z.string().min(1), topUpId: z.string().min(1), creditedAmount: DecimalSatSchema, unit: z.literal("sat"), settlementReference: z.string().min(1),
}).strict();

export const FundingResultSchema = z.union([CreditedSettlementResultSchema, FundedAdmissionSchema]);

export type Principal = z.infer<typeof PrincipalSchema>;
export type VerifiedSettlement = z.infer<typeof VerifiedSettlementSchema>;
export type AuthenticatedFundingCommand = z.infer<typeof AuthenticatedFundingCommandSchema>;
export type AccountStatus = z.infer<typeof AccountStatusSchema>;
export type AccountTopUpStatus = z.infer<typeof AccountTopUpStatusSchema>;
export type FundedAdmission = z.infer<typeof FundedAdmissionSchema>;
export type FundingResult = z.infer<typeof FundingResultSchema>;
