import { z } from "zod";
import { FundingService } from "../funding/funding-service";
import { PrincipalSchema } from "../phase-03/contracts";
import { CreditAmountSchema, PaymentMethodIdSchema, type CreditGrant, type CreditGrantPort } from "./contracts";

const GrantSchema = z.object({ principal: PrincipalSchema, reference: z.string().min(1).max(512), credits: CreditAmountSchema, verifiedAt: z.iso.datetime(), policyVersion: z.string().min(1).max(128) }).strict();

/** Adapters supply already verified integer credits. Each adapter has a separate replay namespace. */
export function adapterCreditGrants(funding: FundingService, adapterId: string): CreditGrantPort {
  const id = PaymentMethodIdSchema.parse(adapterId);
  return Object.freeze({
    async grant(input: CreditGrant) {
      const grant = GrantSchema.parse(input);
      const reference = `credit:${id}:${new Bun.CryptoHasher("sha256").update(grant.reference).digest("hex")}`;
      return funding.execute({
        kind: "credit_settlement", principal: grant.principal, idempotencyKey: reference,
        policyVersion: grant.policyVersion, protocolVersion: "credit-grant-v1",
        payload: { settlement: {
          topUpId: reference, rail: id, unit: "sat", amount: grant.credits,
          externalReference: reference, settlementReference: reference,
          verifiedAt: grant.verifiedAt,
        } },
      });
    },
  });
}

/** Integer conversion helper for operator adapters. Fractional credits never round up. */
export function purchasedCredits(amount: string, ratio: Readonly<{ numerator: string; denominator: string }>): string {
  const integer = z.string().regex(/^[1-9][0-9]{0,35}$/u);
  const value = BigInt(integer.parse(amount)) * BigInt(integer.parse(ratio.numerator)) / BigInt(integer.parse(ratio.denominator));
  return CreditAmountSchema.parse(value.toString());
}
