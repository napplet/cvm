import { z } from "zod";

const Money = z.string().regex(/^\d{1,30}$/u);
export const ProjectSpendSchema = z.object({ confirmed: Money, pending: z.number().int().nonnegative(), requests: z.number().int().nonnegative() });
export const RequestCostSchema = z.object({
  id: z.string(), requestKey: z.string(), number: z.number().int().positive(),
  kind: z.enum(["create", "revise"]), prompt: z.string().max(512).nullable(),
  state: z.string(), version: z.number().int().nullable(), createdAt: z.string(),
  charge: Money.nullable(), maximum: Money,
  lines: z.array(z.object({ dimension: z.enum(["input_tokens", "output_tokens", "cached_tokens", "reasoning_tokens"]), units: Money, numerator: Money, denominator: Money, charge: Money })),
});
export const ProjectCostsSchema = z.object({
  sessionId: z.string(), unit: z.literal("test_sat"), total: ProjectSpendSchema,
  requests: z.array(RequestCostSchema).max(50), nextCursor: z.string().nullable(),
});
export type ProjectSpend = z.infer<typeof ProjectSpendSchema>;
export type RequestCost = z.infer<typeof RequestCostSchema>;
export type ProjectCosts = z.infer<typeof ProjectCostsSchema>;
