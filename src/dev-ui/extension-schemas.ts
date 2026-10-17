import { z } from "zod";

export const ServiceInfoArgumentsSchema = z.object({}).strict();
export const DevelopmentFaucetArgumentsSchema = z.object({ amount: z.string().regex(/^[1-9][0-9]{0,4}$/u) }).strict();
export const OperationDiagnosticArgumentsSchema = z.object({ operationId: z.string().min(1).max(240) }).strict();
