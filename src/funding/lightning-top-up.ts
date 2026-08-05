import { canonicalJson } from "../promotion/schema";
import { accountIdForPrincipal } from "../domain/account-command";
import { PrincipalSchema, type FundingResult, type Principal, type VerifiedSettlement } from "../phase-03/contracts";
import type { FundingService } from "./funding-service";
import { LightningInvoiceObservationSchema, type LightningInvoiceObservation, type LightningReceiptPort } from "./lightning-provider";
import type { ProtectedRailMaterialVault } from "./protected-rail-material";
import type { VerifiedCreditWakeDispatcher } from "../continuity/continuation-service";

type TopUpState = "pending" | "settled" | "credited" | "failed" | "reconciliation_pending";
export type LightningTopUpStatus = Readonly<{
  topUpId: string; rail: "lightning"; state: TopUpState; amount: string; unit: "sat";
  createdAt: string; safeDisplayReference?: string; expiresAt?: string; settlementReference?: string;
}>;
export type LightningTopUpResult = Readonly<{
  status: "payment_required" | "reconciliation_pending" | "failed" | "credited";
  topUpId: string; rail: "lightning"; state: TopUpState; amount: string; unit: "sat";
  safeDisplayReference?: string; expiresAt?: string; settlementReference?: string;
}>;
export type BeginLightningTopUpInput = Readonly<{
  principal: Principal; idempotencyKey: string; amount: string; unit: "sat"; policyVersion: string; protocolVersion: string;
}>;

export type LightningPrivateTopUp = LightningTopUpStatus & Readonly<{
  accountId: string; principal: Principal; commandFingerprint: string; commandKey: string; providerIntent: "created" | "completed" | "uncertain";
  providerReference: string; invoiceIdentityDigest?: string; paymentHashDigest?: string; protectedMaterialId?: string;
  protectedPayloadDigest?: string; creditedResult?: FundingResult;
}>;
export type LightningTopUpState = { topUps: Map<string, LightningPrivateTopUp>; commands: Map<string, { fingerprint: string; topUpId: string }> };

export interface LightningTopUpRepository {
  transact<T>(operation: (state: LightningTopUpState) => Promise<T> | T): Promise<T>;
  snapshot?(): readonly LightningTopUpStatus[];
}

function clone<T>(value: T): T { return structuredClone(value); }
function frozen<T>(value: T): T { return Object.freeze(clone(value)); }
function commandKey(accountId: string, idempotencyKey: string): string { return `${accountId.length}:${accountId}${idempotencyKey.length}:${idempotencyKey}`; }
function publicStatus(topUp: LightningPrivateTopUp): LightningTopUpStatus {
  const { topUpId, rail, state, amount, unit, createdAt, safeDisplayReference, expiresAt, settlementReference } = topUp;
  return frozen({ topUpId, rail, state, amount, unit, createdAt, ...(safeDisplayReference ? { safeDisplayReference } : {}), ...(expiresAt ? { expiresAt } : {}), ...(settlementReference ? { settlementReference } : {}) });
}
function publicResult(topUp: LightningPrivateTopUp): LightningTopUpResult {
  const base = publicStatus(topUp);
  return frozen({ status: topUp.state === "credited" ? "credited" : topUp.state === "failed" ? "failed" : topUp.state === "reconciliation_pending" ? "reconciliation_pending" : "payment_required", ...base });
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
const isPositiveSat = (value: string) => /^[1-9][0-9]*$/u.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);

/** Deterministic test double; production composition must inject a durable rail repository. */
export class InMemoryLightningTopUpRepository implements LightningTopUpRepository {
  #state: LightningTopUpState = { topUps: new Map(), commands: new Map() }; #tail = Promise.resolve();
  async transact<T>(operation: (state: LightningTopUpState) => Promise<T> | T): Promise<T> {
    let release!: () => void; const prior = this.#tail; this.#tail = new Promise<void>((resolve) => { release = resolve; }); await prior;
    try { const staged = clone(this.#state); const output = await operation(staged); this.#state = staged; return frozen(output); } finally { release(); }
  }
  snapshot(): readonly LightningTopUpStatus[] { return frozen([...this.#state.topUps.values()].map(publicStatus)); }
}

export type LightningTopUpCoordinatorOptions = Readonly<{
  funding: FundingService; receiver: LightningReceiptPort; repository: LightningTopUpRepository; vault: ProtectedRailMaterialVault; verifiedCreditWake?: VerifiedCreditWakeDispatcher; now?: () => string; providerTimeoutMs?: number;
}>;

/** Service-owned BOLT11 coordinator: receiver observations never receive ledger authority. */
export class LightningTopUpCoordinator {
  readonly #now: () => string;
  readonly #providerTimeoutMs: number;
  constructor(private readonly options: LightningTopUpCoordinatorOptions) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#providerTimeoutMs = options.providerTimeoutMs ?? 5_000;
    if (this.#providerTimeoutMs < 1) throw new Error("INVALID_PROVIDER_TIMEOUT");
  }

  async begin(input: unknown): Promise<LightningTopUpResult> {
    const command = this.parseBegin(input); const accountId = await accountIdForPrincipal(command.principal); const fingerprint = await this.fingerprint(command, accountId); const key = commandKey(accountId, command.idempotencyKey);
    const claim = await this.options.repository.transact(async (state) => {
      const recorded = state.commands.get(key);
      if (recorded) {
        if (recorded.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
        const topUp = state.topUps.get(recorded.topUpId); if (!topUp) throw new Error("LIGHTNING_TOPUP_CORRUPT");
        // A process can disappear after the durable intent but before recording a
        // receiver response.  Treat any non-terminal intent as opaque and query
        // its immutable reference; it is never a permit to create again.
        return frozen({ mode: topUp.providerIntent !== "completed" ? "reconcile" as const : "replay" as const, topUp });
      }
      const topUpId = `lightning:${(await sha256(`${accountId}:${command.idempotencyKey}`)).slice(0, 32)}`;
      const topUp: LightningPrivateTopUp = frozen({ topUpId, accountId, principal: command.principal, commandFingerprint: fingerprint, commandKey: key, rail: "lightning", state: "pending", amount: command.amount, unit: "sat", createdAt: this.#now(), providerIntent: "created", providerReference: `invoice-create:${topUpId}` });
      state.topUps.set(topUpId, topUp); state.commands.set(key, { fingerprint, topUpId });
      return frozen({ mode: "dispatch" as const, topUp });
    });
    if (claim.mode === "replay") return publicResult(claim.topUp);
    if (claim.mode === "reconcile") return this.reconcileRecord(claim.topUp);
    try {
      const observed = await this.boundedProvider((signal) => this.options.receiver.createInvoice({ topUpId: claim.topUp.topUpId, idempotencyLabel: claim.topUp.topUpId, amount: claim.topUp.amount, unit: "sat", signal }));
      return this.recordObservation(claim.topUp.topUpId, observed);
    } catch { return this.markUnknown(claim.topUp.topUpId); }
  }

  async reconcile(input: Readonly<{ principal: Principal; topUpId: string }>): Promise<LightningTopUpResult> {
    const principal = PrincipalSchema.parse(input.principal); const accountId = await accountIdForPrincipal(principal);
    const topUp = await this.options.repository.transact((state) => {
      const found = state.topUps.get(input.topUpId); if (!found || found.accountId !== accountId) throw new Error("LIGHTNING_TOPUP_NOT_FOUND"); return found;
    });
    return this.reconcileRecord(topUp);
  }

  async observeSettlement(input: Readonly<{ principal: Principal; topUpId: string }>): Promise<LightningTopUpResult> {
    return this.reconcile(input);
  }

  private async reconcileRecord(topUp: LightningPrivateTopUp): Promise<LightningTopUpResult> {
    if (topUp.state === "credited") {
      await this.options.verifiedCreditWake?.dispatchVerifiedCredit(topUp.accountId);
      return publicResult(topUp);
    }
    if (topUp.state === "failed") return publicResult(topUp);
    try { return this.recordObservation(topUp.topUpId, await this.boundedProvider((signal) => this.options.receiver.queryInvoice({ topUpId: topUp.topUpId, serviceReference: topUp.providerReference, signal }))); }
    catch { return this.markUnknown(topUp.topUpId); }
  }

  private async recordObservation(topUpId: string, raw: unknown): Promise<LightningTopUpResult> {
    const observed = LightningInvoiceObservationSchema.parse(raw);
    if (observed.status === "created") return this.recordCreated(topUpId, observed);
    if (observed.status === "failed") return this.options.repository.transact((state) => {
      const topUp = this.topUp(state, topUpId); this.assertObservationTarget(topUp, observed);
      const next = frozen({ ...topUp, state: "failed" as const, providerIntent: "completed" as const }); state.topUps.set(topUpId, next); return publicResult(next);
    });
    if (observed.status === "unknown") return this.markUnknown(topUpId);
    return this.recordSettled(topUpId, observed);
  }

  private async recordCreated(topUpId: string, observed: Extract<LightningInvoiceObservation, { status: "created" }>): Promise<LightningTopUpResult> {
    const topUp = await this.options.repository.transact((state) => this.topUp(state, topUpId));
    this.assertObservationTarget(topUp, observed);
    if (observed.amount !== topUp.amount || observed.unit !== "sat" || Date.parse(observed.expiresAt) <= Date.parse(this.#now())) throw new Error("LIGHTNING_INVOICE_MISMATCH");
    const sealed = await this.options.vault.seal({ accountId: topUp.accountId, topUpId, rail: "lightning" }, new TextEncoder().encode(observed.invoice), observed.expiresAt);
    const invoiceIdentityDigest = await sha256(observed.invoiceIdentity); const paymentHashDigest = await sha256(observed.paymentHash);
    return this.options.repository.transact((state) => {
      const current = this.topUp(state, topUpId);
      if (current.protectedMaterialId) return publicResult(current);
      const next = frozen({ ...current, state: "pending" as const, providerIntent: "completed" as const, providerReference: observed.serviceReference, expiresAt: observed.expiresAt, safeDisplayReference: observed.safeDisplayReference, protectedMaterialId: sealed.id, protectedPayloadDigest: sealed.payloadDigest, invoiceIdentityDigest, paymentHashDigest });
      state.topUps.set(topUpId, next); return publicResult(next);
    });
  }

  private async recordSettled(topUpId: string, observed: Extract<LightningInvoiceObservation, { status: "settled" }>): Promise<LightningTopUpResult> {
    const topUp = await this.options.repository.transact((state) => this.topUp(state, topUpId));
    this.assertObservationTarget(topUp, observed);
    if (topUp.state === "credited") {
      await this.options.verifiedCreditWake?.dispatchVerifiedCredit(topUp.accountId);
      return publicResult(topUp);
    }
    if (!topUp.paymentHashDigest || !topUp.invoiceIdentityDigest || !topUp.expiresAt || observed.amount !== topUp.amount || observed.unit !== "sat" || observed.expiresAt !== topUp.expiresAt || !observed.final || Date.parse(this.#now()) > Date.parse(topUp.expiresAt) || Date.parse(observed.settledAt) > Date.parse(topUp.expiresAt) || Date.parse(observed.settledAt) > Date.parse(this.#now()) || await sha256(observed.paymentHash) !== topUp.paymentHashDigest || await sha256(observed.invoiceIdentity) !== topUp.invoiceIdentityDigest) return this.markUnknown(topUpId);
    const settlement: VerifiedSettlement = { topUpId, rail: "lightning", unit: "sat", amount: topUp.amount, externalReference: `lightning:${await sha256(`${topUpId}:${observed.paymentHash}`)}`, settlementReference: observed.settlementReference, verifiedAt: observed.settledAt };
    let credited: LightningTopUpResult;
    try {
      const result = await this.options.funding.execute({ principal: topUp.principal, kind: "credit_settlement", idempotencyKey: `lightning-settlement:${topUpId}:${observed.settlementReference}`, policyVersion: "lightning-receipt-v1", protocolVersion: "funding-contract-v1", payload: { settlement } });
      credited = await this.options.repository.transact(async (state) => {
        const current = this.topUp(state, topUpId); const next = frozen({ ...current, state: "credited" as const, providerIntent: "completed" as const, settlementReference: observed.settlementReference, creditedResult: result }); state.topUps.set(topUpId, next);
        if (current.protectedMaterialId) await this.options.vault.expire(current.protectedMaterialId); return publicResult(next);
      });
    } catch (error) {
      if (error instanceof Error && error.message === "SETTLEMENT_REFERENCE_CONFLICT") return this.markUnknown(topUpId);
      return this.markUnknown(topUpId);
    }
    await this.options.verifiedCreditWake?.dispatchVerifiedCredit(topUp.accountId);
    return credited;
  }

  private async markUnknown(topUpId: string): Promise<LightningTopUpResult> {
    return this.options.repository.transact((state) => { const topUp = this.topUp(state, topUpId); if (topUp.state === "credited" || topUp.state === "failed") return publicResult(topUp); const next = frozen({ ...topUp, state: "reconciliation_pending" as const, providerIntent: "uncertain" as const }); state.topUps.set(topUpId, next); return publicResult(next); });
  }
  private async boundedProvider<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(controller.signal), new Promise<T>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("RAIL_PROVIDER_DEADLINE_EXCEEDED")); }, this.#providerTimeoutMs); })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private topUp(state: LightningTopUpState, topUpId: string): LightningPrivateTopUp { const topUp = state.topUps.get(topUpId); if (!topUp) throw new Error("LIGHTNING_TOPUP_NOT_FOUND"); return topUp; }
  private assertObservationTarget(topUp: LightningPrivateTopUp, observed: LightningInvoiceObservation): void { if (observed.topUpId && observed.topUpId !== topUp.topUpId) throw new Error("LIGHTNING_RECEIPT_TOPUP_MISMATCH"); if (observed.serviceReference !== topUp.providerReference && topUp.providerReference !== `invoice-create:${topUp.topUpId}`) throw new Error("LIGHTNING_RECEIPT_REFERENCE_MISMATCH"); }
  private parseBegin(input: unknown): BeginLightningTopUpInput { const value = input as Partial<BeginLightningTopUpInput>; const principal = PrincipalSchema.parse(value.principal); if (!value.idempotencyKey || !value.policyVersion || !value.protocolVersion || value.unit !== "sat" || typeof value.amount !== "string" || !isPositiveSat(value.amount)) throw new Error("LIGHTNING_TOPUP_COMMAND_INVALID"); return frozen({ principal, idempotencyKey: value.idempotencyKey, amount: value.amount, unit: "sat", policyVersion: value.policyVersion, protocolVersion: value.protocolVersion }); }
  private async fingerprint(command: BeginLightningTopUpInput, accountId: string): Promise<string> { return sha256(canonicalJson({ accountId, principal: command.principal.pubkey, kind: "lightning_top_up", idempotencyKey: command.idempotencyKey, amount: command.amount, unit: command.unit, policyVersion: command.policyVersion, protocolVersion: command.protocolVersion })); }
}
