import { accountIdForPrincipal, fingerprintAccountCommand } from "../domain/account-command";
import { AccountStatusSchema, AuthenticatedFundingCommandSchema, type FundingResult, type Principal } from "../phase-03/contracts";
import type { FundingStore } from "../persistence/funding-store";

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Transport-neutral coordination layer. It owns no rail I/O, worker, or provider authority. */
export class FundingService {
  constructor(private readonly store: FundingStore) {}

  async execute(input: unknown): Promise<FundingResult> {
    const command = AuthenticatedFundingCommandSchema.parse(input);
    const accountId = await accountIdForPrincipal(command.principal);
    const fingerprint = await fingerprintAccountCommand(command, accountId);
    const replay = await this.store.findRecordedResult(accountId, command.idempotencyKey);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
      return freeze(structuredClone(replay.result));
    }
    return this.store.transact(accountId, (transaction) => {
      const insideReplay = transaction.findRecordedResult(command.idempotencyKey);
      if (insideReplay) {
        if (insideReplay.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
        return insideReplay.result;
      }
      if (command.kind === "credit_settlement") {
        return transaction.creditVerifiedSettlement({ accountId, fingerprint, idempotencyKey: command.idempotencyKey, settlement: command.payload.settlement });
      }
      if (!command.payload.capacity.usable) throw new Error("CAPACITY_UNAVAILABLE");
      return transaction.acceptFundedAdmission({ accountId, fingerprint, idempotencyKey: command.idempotencyKey, requestedCap: BigInt(command.payload.requestedCap), capacityReference: command.payload.capacity.reference });
    });
  }

  async status(principalInput: unknown) {
    const principal = (await import("../phase-03/contracts")).PrincipalSchema.parse(principalInput) as Principal;
    const accountId = await accountIdForPrincipal(principal);
    const status = await this.store.status(accountId);
    return status ? AccountStatusSchema.parse(status) : AccountStatusSchema.parse({ accountId, unit: "sat", available: "0", held: "0", topUps: [], admissions: [] });
  }
}
