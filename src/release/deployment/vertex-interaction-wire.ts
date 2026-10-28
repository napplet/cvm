import { z } from "zod";

const Count = z.number().int().nonnegative();
const LegacyUsage = z.object({ input_tokens: Count, cached_input_tokens: Count, output_tokens: Count, thought_tokens: Count, tool_use_tokens: Count }).passthrough();
const TextModality = z.array(z.object({ modality: z.literal("text"), tokens: Count }).passthrough()).max(1);
const CurrentUsage = z.object({
  total_input_tokens: Count, total_cached_tokens: Count, total_output_tokens: Count, total_thought_tokens: Count, total_tool_use_tokens: Count, total_tokens: Count,
  input_tokens_by_modality: TextModality.optional(), cached_tokens_by_modality: TextModality.optional(), output_tokens_by_modality: TextModality.optional(), tool_use_tokens_by_modality: TextModality.optional(),
  grounding_tool_count: z.array(z.object({ type: z.enum(["google_search", "google_maps", "retrieval"]), count: Count }).passthrough()).max(16).optional(),
}).passthrough().superRefine((value, ctx) => {
  // With tools disabled, this is input + final output + thoughts. Cached
  // tokens are part of input, not a second contribution to total_tokens.
  if (value.total_tool_use_tokens !== 0 || BigInt(value.total_tokens) !== BigInt(value.total_input_tokens) + BigInt(value.total_output_tokens) + BigInt(value.total_thought_tokens)) ctx.addIssue({ code: "custom", message: "VERTEX_USAGE_TOTAL_UNPROVEN" });
  const modalities = [[value.input_tokens_by_modality, value.total_input_tokens], [value.cached_tokens_by_modality, value.total_cached_tokens], [value.output_tokens_by_modality, value.total_output_tokens], [value.tool_use_tokens_by_modality, value.total_tool_use_tokens]] as const;
  if (modalities.some(([parts, total]) => parts && parts.reduce((sum, part) => sum + part.tokens, 0) !== total) || value.grounding_tool_count?.some(tool => tool.count !== 0)) ctx.addIssue({ code: "custom", message: "VERTEX_TEXT_ONLY_USAGE_REQUIRED" });
});
const InputText = z.object({ type: z.literal("text"), text: z.string().min(1).max(32_000) }).strict();
const LegacyInput = z.array(z.object({ role: z.literal("user"), content: z.array(InputText).length(1) }).strict()).length(1);
const UserStep = z.object({ type: z.literal("user_input"), content: z.array(InputText).length(1), model_output: z.never().optional() }).passthrough();
const Input = z.union([
  LegacyInput,
  z.array(InputText).length(1).transform(content => [{ role: "user" as const, content }]),
  z.array(UserStep).length(1).transform(steps => [{ role: "user" as const, content: steps[0]!.content }]),
  z.string().min(1).max(32_000).transform(text => [{ role: "user" as const, content: [{ type: "text" as const, text }] }]),
]);
const OutputText = z.object({ type: z.literal("text"), text: z.string().min(1).max(1_000_000) }).passthrough();
const LegacySteps = z.array(z.object({ model_output: z.object({ content: z.array(OutputText).min(1).max(64) }).strict().optional() }).passthrough()).max(128);
const CurrentSteps = z.array(z.discriminatedUnion("type", [
  UserStep,
  z.object({ type: z.literal("model_output"), content: z.array(OutputText).max(64).optional(), model_output: z.never().optional() }).passthrough(),
  z.object({ type: z.literal("thought"), model_output: z.never().optional() }).passthrough(),
])).max(128);
const Header = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u), model: z.literal("gemini-4-argon"), status: z.enum(["in_progress", "completed", "incomplete", "failed", "cancelled", "queued", "requires_action"]), created: z.string().datetime(), input: z.unknown().optional(), usage: z.unknown().optional(), steps: z.array(z.unknown()).max(128).optional(), previous_interaction_id: z.never().optional() }).passthrough();
const legacyCounters = ["input_tokens", "cached_input_tokens", "output_tokens", "thought_tokens", "tool_use_tokens"];
const currentCounters = ["total_input_tokens", "total_cached_tokens", "total_output_tokens", "total_thought_tokens", "total_tool_use_tokens", "total_tokens"];

type OutputStep = Readonly<{ model_output?: Readonly<{ content: readonly Readonly<{ type: "text"; text: string }>[] }> }>;
export type VertexInteraction = Readonly<{
  wire: "current" | "legacy"; id: string; model: "gemini-4-argon"; status: z.infer<typeof Header>["status"]; created: string;
  input?: z.infer<typeof LegacyInput>; usage?: z.infer<typeof LegacyUsage>; steps?: readonly OutputStep[];
}>;

/** Current raw REST and retained legacy evidence are decoded explicitly. This
 * module has no effect or financial authority and never invents missing usage.
 * Official current types: Interactions API reference and googleapis/js-genai's
 * gaos/models/interactions/{usage,step,text-response-format}.ts. */
export function parseVertexInteraction(raw: unknown): VertexInteraction | undefined {
  const parsed = Header.safeParse(raw);
  if (!parsed.success) return undefined;
  const header = parsed.data;
  const usageObject = header.usage === undefined ? undefined : z.record(z.string(), z.unknown()).safeParse(header.usage);
  if (usageObject && !usageObject.success) return undefined;
  const counters = usageObject?.data ?? {};
  let legacy = legacyCounters.some(key => Object.hasOwn(counters, key));
  let current = currentCounters.some(key => Object.hasOwn(counters, key));
  for (const rawStep of header.steps ?? []) {
    const step = z.record(z.string(), z.unknown()).safeParse(rawStep);
    if (!step.success) return undefined;
    legacy ||= Object.hasOwn(step.data, "model_output");
    current ||= Object.hasOwn(step.data, "type");
  }
  if (legacy && current) return undefined;
  const wire = legacy ? "legacy" : "current";
  let input: z.infer<typeof LegacyInput> | undefined;
  if (header.input !== undefined) {
    const evidence = Input.safeParse(header.input);
    if (!evidence.success) return undefined;
    input = evidence.data;
  }
  let usage: z.infer<typeof LegacyUsage> | undefined;
  if (header.usage !== undefined) {
    if (wire === "legacy") {
      const value = LegacyUsage.safeParse(header.usage);
      if (!value.success) return undefined;
      usage = value.data;
    } else {
      const value = CurrentUsage.safeParse(header.usage);
      if (!value.success) return undefined;
      usage = { input_tokens: value.data.total_input_tokens, cached_input_tokens: value.data.total_cached_tokens, output_tokens: value.data.total_output_tokens, thought_tokens: value.data.total_thought_tokens, tool_use_tokens: value.data.total_tool_use_tokens };
    }
  }
  let steps: readonly OutputStep[] | undefined;
  if (wire === "legacy") {
    if (!input) return undefined;
    const value = LegacySteps.safeParse(header.steps ?? []);
    if (!value.success) return undefined;
    steps = value.data;
  } else {
    const value = CurrentSteps.safeParse(header.steps ?? []);
    if (!value.success) return undefined;
    const userInputs = value.data.filter(step => step.type === "user_input");
    if (userInputs.length > 1) return undefined;
    const user = userInputs[0];
    if (user) {
      const evidence = [{ role: "user" as const, content: user.content }];
      if (input && JSON.stringify(input) !== JSON.stringify(evidence)) return undefined;
      input = evidence;
    }
    const parts = value.data.flatMap(step => step.type === "model_output" ? step.content?.map(part => part.text) ?? [] : []);
    const output = parts.join("");
    if (output.length > 1_000_000) return undefined;
    steps = parts.length ? [{ model_output: { content: [{ type: "text", text: output }] } }] : [];
  }
  return Object.freeze({ wire, id: header.id, model: header.model, status: header.status, created: header.created, ...(input ? { input } : {}), ...(usage ? { usage } : {}), ...(steps ? { steps } : {}) });
}
