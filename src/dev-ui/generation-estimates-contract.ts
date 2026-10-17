import { z } from "zod";

const Sat = z.string().regex(/^(0|[1-9][0-9]{0,18})$/u);
const Estimate = z.object({
  samples: z.number().int().min(1).max(30),
  basis: z.enum(["create", "revise", "all"]),
  cost: z.object({ low: Sat, high: Sat }).strict().refine(v => BigInt(v.low) <= BigInt(v.high)),
  seconds: z.object({ low: z.number().int().positive(), high: z.number().int().positive() }).strict().refine(v => v.low <= v.high),
}).strict();

export const GenerationEstimatesSchema = z.object({
  unit: z.literal("test_sat"), windowDays: z.literal(30),
  create: Estimate.nullable(), revise: Estimate.nullable(),
}).strict();
export type GenerationEstimates = z.infer<typeof GenerationEstimatesSchema>;
export type GenerationEstimate = NonNullable<GenerationEstimates["create"]>;
