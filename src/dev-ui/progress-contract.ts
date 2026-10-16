import { z } from "zod";

export const progressMethod = "notifications/development_progress";
export const progressTools = ["funded_admission", "start_session", "revise_session", "resume_session", "preview"] as const;
export const progressStages = {
  request: "Server request", admission: "Capacity and funds reservation",
  model: "Model operation", model_stream: "Receiving model response", model_recorded: "Source and usage receipt recorded",
  worker: "Isolated Docker worker", create: "Scaffold napplet", init: "Initialize manifest", skills: "Install authoring guidance",
  install: "Install pinned dependencies offline", build: "Build napplet", verify: "Check guidance and TypeScript",
  conformance: "Chromium conformance", "dry-run": "Deployment dry run", artifact: "Verify and seal artifact",
  ledger: "Settle metered ledger", preview: "Prepare sandboxed preview",
} as const;
export type ProgressStage = keyof typeof progressStages;
export type ProgressState = "running" | "completed" | "failed" | "uncertain";
export const DevelopmentProgressSchema = z.object({
  version: z.literal(1), requestId: z.union([z.string().min(1).max(128), z.number().int().safe()]),
  tool: z.enum(progressTools), sequence: z.number().int().min(1).max(10000),
  at: z.number().int().nonnegative().safe(), elapsedMs: z.number().int().min(0).max(3600000),
  kind: z.enum(["stage", "heartbeat"]), stage: z.enum(Object.keys(progressStages) as [ProgressStage, ...ProgressStage[]]),
  state: z.enum(["running", "completed", "failed", "uncertain"]),
  bytes: z.number().int().min(0).max(2_000_000).optional(),
  provider: z.enum(["deterministic_fixture", "openai_responses", "openai_chatgpt_development"]).optional(),
  model: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:/-]+$/u).optional(),
}).strict();
export type DevelopmentProgress = z.infer<typeof DevelopmentProgressSchema>;

export function acceptDevelopmentProgress(value: unknown, pending: { id: string | number; tool: string; sequence: number }): DevelopmentProgress | undefined {
  const parsed = DevelopmentProgressSchema.safeParse(value);
  if (!parsed.success || parsed.data.requestId !== pending.id || parsed.data.tool !== pending.tool || parsed.data.sequence <= pending.sequence) return undefined;
  return parsed.data;
}
