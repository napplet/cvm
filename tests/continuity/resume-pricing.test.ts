import { expect, test } from "bun:test";
import { resumePricingContext, resumePricingMaterial } from "../fixtures/resume-pricing";
import { prepareResumePricingQuote, verifyStoredResumePricingQuote, type ResumePricingContext } from "../../src/continuity/resume-pricing";

const now = Date.parse("2026-08-04T00:00:00.000Z");
const context = resumePricingContext(now);
const pricing = () => resumePricingMaterial(now);
async function quote() { return prepareResumePricingQuote({ context, pricing: await pricing(), preparationKey: "prepare:one", nowMs: now, lifetimeMs: 300_000 }); }

test("a changed estimate needs exact explicit approval and stays below the original action maximum", async () => {
  const stored = await quote();
  expect(stored.maximumUsdMicros).toBe("220");
  expect(stored.maximumSat).toBe("3");
  expect(stored.context.pendingAction.maximum).toBe("1");
  expect(stored.context.originalCommandMaximum).toBe("50");
  expect(stored.expiresAtMs).toBe(now + 90_000);
  const approval = { quoteReference: stored.quoteReference, quoteSha256: stored.quoteSha256, maximumSat: "3" };
  expect(await verifyStoredResumePricingQuote({ stored, expectedContext: context, approval, nowMs: now + 1 })).toEqual(stored);
  await expect(verifyStoredResumePricingQuote({ stored, expectedContext: context, approval: { ...approval, maximumSat: "1" }, nowMs: now + 1 })).rejects.toThrow("RESUME_QUOTE_APPROVAL_MISMATCH");
  await expect(prepareResumePricingQuote({ context: { ...context, originalCommandMaximum: "2" }, pricing: await pricing(), preparationKey: "prepare:two", nowMs: now, lifetimeMs: 1000 })).rejects.toThrow("RESUME_QUOTE_EXCEEDS_COMMAND_MAXIMUM");
});

test("owner, checkpoint, original command, settlement and compatibility mutations cannot accept a saved quote", async () => {
  const stored = await quote();
  const approval = { quoteReference: stored.quoteReference, quoteSha256: stored.quoteSha256, maximumSat: stored.maximumSat };
  const mutations: readonly ResumePricingContext[] = [
    { ...context, accountId: "account:other" }, { ...context, sessionId: "session:other" }, { ...context, checkpointId: "checkpoint:other" },
    { ...context, checkpointSha256: "f".repeat(64) }, { ...context, expectedSessionVersion: 2 }, { ...context, expectedArtifactVersion: 2 },
    { ...context, commandSha256: "f".repeat(64) }, { ...context, originalOperationId: "operation:other" }, { ...context, originalSettlementSha256: "f".repeat(64) },
    { ...context, originalCommandMaximum: "51" }, { ...context, policyVersion: "policy:other" }, { ...context, toolchainId: "toolchain:other" },
    { ...context, pendingAction: { ...context.pendingAction, fingerprint: "f".repeat(64) } }, { ...context, retentionUntilMs: now + 10_000 },
  ];
  for (const expectedContext of mutations) await expect(verifyStoredResumePricingQuote({ stored, expectedContext, approval, nowMs: now + 1 })).rejects.toThrow("RESUME_QUOTE_CONTEXT_MISMATCH");
  await expect(verifyStoredResumePricingQuote({ stored, expectedContext: { ...context, realm: "development-test" }, approval, nowMs: now + 1 })).rejects.toThrow();
});

test("expiry is enforced at first dispatch and a modified record cannot borrow its old approval", async () => {
  const stored = await quote();
  const approval = { quoteReference: stored.quoteReference, quoteSha256: stored.quoteSha256, maximumSat: stored.maximumSat };
  for (const nowMs of [now - 1, stored.expiresAtMs, stored.expiresAtMs + 1]) await expect(verifyStoredResumePricingQuote({ stored, expectedContext: context, approval, nowMs })).rejects.toThrow("RESUME_QUOTE_EXPIRED");
  for (const changed of [
    { ...stored, maximumUsdMicros: "1" }, { ...stored, priceSourcesSha256: "f".repeat(64) }, { ...stored, preparationKey: "prepare:other" },
    { ...stored, pricing: { ...stored.pricing, profile: { ...stored.pricing.profile, maximumUnits: [{ dimension: "input_tokens", units: "1" }] } } },
  ]) await expect(verifyStoredResumePricingQuote({ stored: changed, expectedContext: context, approval, nowMs: now + 1 })).rejects.toThrow("RESUME_QUOTE_RECORD_INVALID");
});

test("future, expired, mismatched conversion and synthetic authorities cannot issue a quote", async () => {
  const original = await pricing();
  const prepare = (value: unknown, nowMs = now) => prepareResumePricingQuote({ context, pricing: value, preparationKey: "prepare:one", nowMs, lifetimeMs: 1000 });
  await expect(prepare(original, now - 1)).rejects.toThrow("RESUME_PRICE_AUTHORITY_STALE");
  await expect(prepare(original, now + 90_000)).rejects.toThrow("RESUME_PRICE_AUTHORITY_STALE");
  await expect(prepare({ ...original, conversion: { ...original.conversion, source: { ...original.conversion.source, capturedBytesSha256: "f".repeat(64) } } })).rejects.toThrow("RESUME_PRICE_AUTHORITY_INVALID");
  await expect(prepare({ ...original, card: { ...original.card, kind: "deterministic_fixture", provider: "deterministic_fixture", currency: "sat" } })).rejects.toThrow("RESUME_PRICE_AUTHORITY_INVALID");
  await expect(prepareResumePricingQuote({ context: { ...context, retentionUntilMs: now }, pricing: original, preparationKey: "prepare:one", nowMs: now, lifetimeMs: 1000 })).rejects.toThrow("RESUME_PRICE_AUTHORITY_STALE");
});
