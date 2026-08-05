import { z } from "zod";
import { PrincipalSchema } from "../phase-03/contracts";

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const AdmissionCommandSchema = z.object({
  principal: PrincipalSchema,
  idempotencyKey: z.string().min(1),
  policyVersion: z.string().min(1),
  protocolVersion: z.string().min(1),
  payload: z.object({ requestedCap: z.string().regex(/^[1-9][0-9]*$/u), unit: z.literal("sat") }).strict(),
}).strict();
const ReceiptClaimsSchema = z.object({
  version: z.literal("admission-receipt-v1"),
  receiptId: z.string().uuid(),
  ownerFingerprint: DigestSchema,
  commandFingerprint: DigestSchema,
  correlationDigest: DigestSchema,
  expectedSessionBindingDigest: DigestSchema,
  approvedAdmissionIdentity: DigestSchema,
  issuedAtMs: z.number().int().min(0).finite(),
  expiresAtMs: z.number().int().positive().finite(),
}).strict().refine((value) => value.expiresAtMs > value.issuedAtMs, "receipt expiry must follow issuance");

export type VerifiedAdmissionReceipt = Readonly<z.infer<typeof ReceiptClaimsSchema>>;
export type AdmissionReceipt = Readonly<{ token: string }>;
export type AdmissionReceiptIssue = Readonly<{
  command: unknown;
  correlationDigest: string;
  expectedSessionBindingDigest: string;
}>;

export interface AdmissionReceiptAuthority {
  issue(input: AdmissionReceiptIssue): Promise<AdmissionReceipt>;
  verify(input: unknown, command: unknown, currentCorrelationDigest?: unknown): Promise<VerifiedAdmissionReceipt>;
}

function webCryptoBytes(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function commandClaims(commandInput: unknown): Promise<Readonly<{ ownerFingerprint: string; commandFingerprint: string }>> {
  const command = AdmissionCommandSchema.parse(commandInput);
  const ownerFingerprint = await sha256(command.principal.pubkey);
  const commandFingerprint = await sha256(JSON.stringify({
    principal: command.principal,
    idempotencyKey: command.idempotencyKey,
    policyVersion: command.policyVersion,
    protocolVersion: command.protocolVersion,
    payload: command.payload,
  }));
  return Object.freeze({ ownerFingerprint, commandFingerprint });
}

/**
 * Server-held capability issuer for the admission boundary. Tokens contain
 * only an opaque nonce and MAC; claims stay coordinator-side. A fresh issuer
 * has no claims for another issuer's token, so cross-instance replay fails.
 */
export class HmacAdmissionReceiptAuthority implements AdmissionReceiptAuthority {
  readonly #secret: Uint8Array;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #claims = new Map<string, VerifiedAdmissionReceipt>();

  constructor(options: Readonly<{ secret: Uint8Array; now?: () => number; ttlMs?: number }>) {
    if (!(options.secret instanceof Uint8Array) || options.secret.length < 32) throw new Error("ADMISSION_RECEIPT_SECRET_INVALID");
    this.#secret = new Uint8Array(options.secret);
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 60_000;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1) throw new Error("ADMISSION_RECEIPT_TTL_INVALID");
  }

  async issue(input: AdmissionReceiptIssue): Promise<AdmissionReceipt> {
    const issue = z.object({ command: z.unknown(), correlationDigest: DigestSchema, expectedSessionBindingDigest: DigestSchema }).strict().parse(input);
    const { ownerFingerprint, commandFingerprint } = await commandClaims(issue.command);
    const issuedAtMs = this.#now();
    if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) throw new Error("ADMISSION_RECEIPT_CLOCK_INVALID");
    const claims = Object.freeze(ReceiptClaimsSchema.parse({
      version: "admission-receipt-v1",
      receiptId: crypto.randomUUID(),
      ownerFingerprint,
      commandFingerprint,
      correlationDigest: issue.correlationDigest,
      expectedSessionBindingDigest: issue.expectedSessionBindingDigest,
      approvedAdmissionIdentity: await sha256(`${ownerFingerprint}:${commandFingerprint}:${issue.correlationDigest}:${issue.expectedSessionBindingDigest}`),
      issuedAtMs,
      expiresAtMs: issuedAtMs + this.#ttlMs,
    }));
    for (const [receiptId, prior] of this.#claims) if (prior.expiresAtMs <= issuedAtMs) this.#claims.delete(receiptId);
    this.#claims.set(claims.receiptId, claims);
    const signature = await this.sign(claims.receiptId);
    return Object.freeze({ token: `ar1.${claims.receiptId}.${signature}` });
  }

  async verify(input: unknown, command: unknown, currentCorrelationDigest?: unknown): Promise<VerifiedAdmissionReceipt> {
    const token = z.object({ token: z.string().min(1) }).strict().safeParse(input);
    if (!token.success) throw new Error("ADMISSION_RECEIPT_INVALID");
    const [prefix, receiptId, signature, ...extra] = token.data.token.split(".");
    if (prefix !== "ar1" || !receiptId || !signature || extra.length > 0 || !z.string().uuid().safeParse(receiptId).success || !(await this.matches(receiptId, signature))) throw new Error("ADMISSION_RECEIPT_INVALID");
    const claims = this.#claims.get(receiptId);
    if (!claims) throw new Error("ADMISSION_RECEIPT_INVALID");
    const expected = await commandClaims(command);
    if (claims.ownerFingerprint !== expected.ownerFingerprint || claims.commandFingerprint !== expected.commandFingerprint) throw new Error("ADMISSION_RECEIPT_COMMAND_MISMATCH");
    if (currentCorrelationDigest !== undefined && claims.correlationDigest !== DigestSchema.parse(currentCorrelationDigest)) throw new Error("ADMISSION_RECEIPT_CORRELATION_MISMATCH");
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now > claims.expiresAtMs || now < claims.issuedAtMs) throw new Error("ADMISSION_RECEIPT_EXPIRED");
    const admissionIdentity = await sha256(`${claims.ownerFingerprint}:${claims.commandFingerprint}:${claims.correlationDigest}:${claims.expectedSessionBindingDigest}`);
    if (claims.approvedAdmissionIdentity !== admissionIdentity) throw new Error("ADMISSION_RECEIPT_INVALID");
    return claims;
  }

  private async sign(payload: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", webCryptoBytes(this.#secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return Buffer.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`admission-receipt-v1.${payload}`)))).toString("base64url");
  }

  private async matches(payload: string, signature: string): Promise<boolean> {
    let value: Uint8Array;
    try { value = new Uint8Array(Buffer.from(signature, "base64url")); }
    catch { return false; }
    if (value.length === 0) return false;
    const key = await crypto.subtle.importKey("raw", webCryptoBytes(this.#secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return crypto.subtle.verify("HMAC", key, webCryptoBytes(value), new TextEncoder().encode(`admission-receipt-v1.${payload}`));
  }
}
