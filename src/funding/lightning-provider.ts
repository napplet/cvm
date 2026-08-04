import { z } from "zod";

const DecimalSatSchema = z.string().regex(/^[1-9][0-9]*$/u);
const IsoTimeSchema = z.iso.datetime();

const CreatedInvoiceObservationSchema = z.object({
  status: z.literal("created"), topUpId: z.string().optional(), serviceReference: z.string().min(1),
  invoice: z.string().min(1), invoiceIdentity: z.string().min(1), paymentHash: z.string().min(1),
  amount: DecimalSatSchema, unit: z.literal("sat"), expiresAt: IsoTimeSchema, safeDisplayReference: z.string().min(1),
}).strict();

const SettledInvoiceObservationSchema = z.object({
  status: z.literal("settled"), topUpId: z.string().min(1), serviceReference: z.string().min(1),
  invoiceIdentity: z.string().min(1), paymentHash: z.string().min(1), amount: DecimalSatSchema,
  unit: z.literal("sat"), expiresAt: IsoTimeSchema, settledAt: IsoTimeSchema, final: z.literal(true),
  settlementReference: z.string().min(1), receiverAuthenticated: z.literal(true),
}).strict();

const FailedInvoiceObservationSchema = z.object({ status: z.literal("failed"), topUpId: z.string().min(1), serviceReference: z.string().min(1), reason: z.enum(["expired", "cancelled", "reversed", "rejected"]) }).strict();
const UnknownInvoiceObservationSchema = z.object({ status: z.literal("unknown"), topUpId: z.string().min(1), serviceReference: z.string().min(1) }).strict();

export const LightningInvoiceObservationSchema = z.discriminatedUnion("status", [CreatedInvoiceObservationSchema, SettledInvoiceObservationSchema, FailedInvoiceObservationSchema, UnknownInvoiceObservationSchema]);
export type LightningInvoiceObservation = z.infer<typeof LightningInvoiceObservationSchema>;
export type LightningCreateInvoiceRequest = Readonly<{ topUpId: string; idempotencyLabel: string; amount: string; unit: "sat" }>;
export type LightningQueryInvoiceRequest = Readonly<{ topUpId: string; serviceReference: string }>;

/** Rail adapter boundary: it returns receiver observations and has no funding/ledger dependency. */
export interface LightningReceiptPort {
  createInvoice(request: LightningCreateInvoiceRequest): Promise<LightningInvoiceObservation>;
  queryInvoice(request: LightningQueryInvoiceRequest): Promise<LightningInvoiceObservation>;
}

type FakeOptions = Readonly<{ create: Extract<LightningInvoiceObservation, { status: "created" }> }>;
/** Deterministic receiver fake. It intentionally exposes only opaque receiver observations. */
export class FakeLightningReceiptPort implements LightningReceiptPort {
  createCalls = 0; queryCalls = 0;
  createMode: "created" | "fail_before_effect" | "effect_then_throw" = "created";
  queryMode: "created" | "settled" | "failed" | "unknown" = "created";
  queryObservation?: LightningInvoiceObservation;
  #created: Extract<LightningInvoiceObservation, { status: "created" }>;
  constructor(options: FakeOptions) { this.#created = LightningInvoiceObservationSchema.parse(options.create) as Extract<LightningInvoiceObservation, { status: "created" }>; }
  async createInvoice(request: LightningCreateInvoiceRequest): Promise<LightningInvoiceObservation> {
    if (this.createMode === "fail_before_effect") throw new Error("LIGHTNING_CREATE_FAILED");
    this.createCalls += 1;
    if (this.createMode === "effect_then_throw") throw new Error("LIGHTNING_CREATE_UNKNOWN");
    return this.created(request.topUpId);
  }
  async queryInvoice(request: LightningQueryInvoiceRequest): Promise<LightningInvoiceObservation> {
    this.queryCalls += 1;
    if (this.queryObservation) return LightningInvoiceObservationSchema.parse({ ...this.queryObservation, topUpId: request.topUpId, serviceReference: request.serviceReference });
    const created = this.created(request.topUpId);
    if (this.queryMode === "created") return created;
    if (this.queryMode === "unknown") return { status: "unknown", topUpId: request.topUpId, serviceReference: request.serviceReference };
    if (this.queryMode === "failed") return { status: "failed", topUpId: request.topUpId, serviceReference: request.serviceReference, reason: "expired" };
    return {
      status: "settled", topUpId: request.topUpId, serviceReference: request.serviceReference,
      invoiceIdentity: created.invoiceIdentity, paymentHash: created.paymentHash, amount: created.amount, unit: "sat",
      expiresAt: created.expiresAt, settledAt: "2026-08-05T00:01:00.000Z", final: true,
      settlementReference: `settlement:${request.topUpId}`, receiverAuthenticated: true,
    };
  }
  private created(topUpId: string): Extract<LightningInvoiceObservation, { status: "created" }> { return { ...this.#created, topUpId }; }
}
