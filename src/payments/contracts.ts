import { z } from "zod";
import type { Principal } from "../phase-03/contracts";
import type { AccountTopUpStatusPort } from "../funding/account-status";

export const PaymentMethodIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,95}$/u);
export const CreditAmountSchema = z.string().regex(/^[1-9][0-9]{0,15}$/u).refine(value => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER));
export const PaymentMethodSchema = z.object({
  id: PaymentMethodIdSchema,
  label: z.string().min(1).max(80),
  description: z.string().max(240).optional(),
  input: z.enum(["invoice", "direct", "external"]),
}).strict();
export type PaymentMethod = Readonly<z.infer<typeof PaymentMethodSchema>>;

/** A server-installed adapter receives only the identity verified by the transport. */
export type PaymentRequest = Readonly<{
  principal: Principal;
  method: string;
  idempotencyKey: string;
  amount: string;
  /** Requested application credits. Absent only for legacy source-amount calls. */
  credits?: string;
  maxFee?: string;
  topUpId?: string;
  invocationHash: string;
  mode: "transparent" | "explicit_gating";
  directPayment?: Readonly<{ pmi: string; payload: string }>;
  policyVersion: string;
  protocolVersion: string;
}>;

/** Only this finite projection crosses the signed/encrypted requester channel. */
export const PaymentResultSchema = z.object({
  topUpId: z.string().min(1).max(256),
  state: z.enum(["pending", "settled", "credited", "failed", "reconciliation_pending", "verifying"]),
  status: z.enum(["payment_required", "reconciliation_pending", "failed", "credited"]).optional(),
  rail: PaymentMethodIdSchema.optional(),
  amount: CreditAmountSchema.optional(),
  unit: z.literal("sat").optional(),
  safeDisplayReference: z.string().min(1).max(256).optional(),
  expiresAt: z.iso.datetime().optional(),
  settlementReference: z.string().min(1).max(256).optional(),
  paymentRequest: z.string().min(1).max(4096).optional(),
  checkoutUrl: z.string().url().refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }).optional(),
}).strip();
export type PaymentResult = Readonly<z.infer<typeof PaymentResultSchema>>;

export interface PaymentAdapter {
  readonly id: string;
  readonly methods: readonly PaymentMethod[];
  request(input: PaymentRequest): Promise<unknown>;
  readonly statuses?: AccountTopUpStatusPort;
  reconcile?(): Promise<void>;
  close?(): Promise<void> | void;
}

/** Server-held grant port. Never register this as a ContextVM tool or HTTP route. */
export type CreditGrant = Readonly<{
  principal: Principal;
  reference: string;
  credits: string;
  verifiedAt: string;
  /** Immutable operator price/quote identity, retained in the command fingerprint. */
  policyVersion: string;
}>;
export interface CreditGrantPort { grant(input: CreditGrant): Promise<unknown> }

export type CreditPolicy = Readonly<{
  version: 1;
  /** Immutable denomination identity; changing the sale price does not change existing credits. */
  id: string;
  label: string;
  /** Exact integer ratio used when normalizing provider USD cost into ledger credits. */
  creditsPerUsd: Readonly<{ numerator: string; denominator: string }>;
}>;
