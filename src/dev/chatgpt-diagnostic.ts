import { z } from "zod";

/** Only bounded operational facts may leave the provider boundary. */
export const ChatGptDiagnosticSchema = z.object({
  code: z.string().regex(/^CHATGPT_[A-Z0-9_]{1,100}$/u),
  phase: z.enum(["request", "stream", "receipt", "persistence"]),
  elapsedMs: z.number().int().nonnegative().max(3_600_000),
  receivedBytes: z.number().int().nonnegative().max(32_000_000),
  httpStatus: z.number().int().min(100).max(599).optional(),
}).strict();
export type ChatGptDiagnostic = z.infer<typeof ChatGptDiagnosticSchema>;

export function classifyChatGptFailure(error: unknown, phase: ChatGptDiagnostic["phase"], signal?: AbortSignal): string {
  // Abort reasons come first: cancelling a reader can otherwise look like EOF.
  const reason = signal?.aborted ? signal.reason : error;
  if (reason instanceof Error && reason.name === "TimeoutError") return "CHATGPT_GENERATION_TIMEOUT";
  if (signal?.aborted || (reason instanceof Error && reason.name === "AbortError")) return "CHATGPT_GENERATION_ABORTED";
  if (error instanceof Error && /^CHATGPT_[A-Z0-9_]{1,100}$/u.test(error.message)) return error.message;
  if (phase === "persistence") return "CHATGPT_RESULT_RECORDING_FAILED";
  if (error instanceof SyntaxError || error instanceof z.ZodError || phase === "receipt") return "CHATGPT_RESPONSE_INVALID";
  if (phase === "request" || phase === "stream") return "CHATGPT_CONNECTION_FAILED";
  return "CHATGPT_REQUEST_FAILED";
}
