import { expect, test } from "bun:test";
import { ResumeSessionCommandSchema, type ResumeSessionCommand } from "../../src/continuity/contracts";
import { PrepareResumeArgumentsSchema, ResumeSessionV2CommandSchema, projectResumePricingQuote } from "../../src/continuity/resume-v2-contracts";
import { prepareResumePricingQuote } from "../../src/continuity/resume-pricing";
import { resumePricingContext, resumePricingMaterial } from "../fixtures/resume-pricing";

test("v2 owner approval is explicit while strict v1 commands keep their original shape", async () => {
  const now = Date.now(), context = resumePricingContext(now);
  const quote = await prepareResumePricingQuote({ context, pricing: await resumePricingMaterial(now), preparationKey: "prepare:one", nowMs: now, lifetimeMs: 30_000 });
  const v1: ResumeSessionCommand = { principal: { id: context.accountId }, sessionId: context.sessionId, checkpointId: context.checkpointId,
    expectedSessionVersion: 1, expectedCheckpointVersion: 1, idempotencyKey: "resume:one", approvePendingAction: true,
    capApprovalReference: "cap:one", pendingAction: context.pendingAction };
  expect(ResumeSessionCommandSchema.parse(v1)).toEqual(v1);
  expect(ResumeSessionV2CommandSchema.safeParse(v1).success).toBeFalse();
  const v2 = { ...v1, pricingApproval: { quoteReference: quote.quoteReference, quoteSha256: quote.quoteSha256, maximumSat: quote.maximumSat } };
  expect(ResumeSessionV2CommandSchema.parse(v2)).toEqual(v2);
  expect(ResumeSessionCommandSchema.safeParse(v2).success).toBeFalse();
  expect(PrepareResumeArgumentsSchema.safeParse({ principal: { id: "account:foreign" }, sessionId: context.sessionId, checkpointId: context.checkpointId,
    expectedSessionVersion: 1, expectedCheckpointVersion: 1, idempotencyKey: "prepare:one" }).success).toBeFalse();
  const publicQuote = await projectResumePricingQuote(quote);
  expect(publicQuote.pricing.maximumSat).toBe("3");
  expect(publicQuote.pendingAction.maximum).toBe("1");
  expect(publicQuote).not.toHaveProperty("context");
  const serialized = JSON.stringify(publicQuote);
  for (const privateValue of [context.accountId, context.commandSha256, context.originalOperationId, context.originalSettlementSha256, context.checkpointSha256])
    expect(serialized).not.toContain(privateValue);
});
