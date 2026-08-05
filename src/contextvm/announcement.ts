import { z } from "zod";

const ToolNameSchema = z.enum([
  "account_status",
  "top_up",
  "funded_admission",
  "start_session",
  "revise_session",
  "resume_session",
  "session_status",
  "preview",
  "publication",
]);

const ContextVmAnnouncementInputSchema = z.object({
  topUpCap: z.object({
    minimum: z.string().regex(/^[1-9][0-9]*$/u),
    maximum: z.string().regex(/^[1-9][0-9]*$/u),
    unit: z.literal("sat"),
  }).strict(),
  pmis: z.array(z.enum(["bitcoin-lightning-bolt11", "bitcoin-cashu-v4-direct"])).length(2),
  paymentInteraction: z.array(z.enum(["transparent", "explicit_gating"])).length(2),
  tools: z.array(z.object({
    name: ToolNameSchema,
    available: z.boolean(),
    planned: z.boolean(),
  }).strict()).min(8).max(9),
}).strict().superRefine((value, context) => {
  if (new Set(value.pmis).size !== 2) context.addIssue({ code: "custom", message: "PMIs must be unique" });
  if (new Set(value.paymentInteraction).size !== 2) context.addIssue({ code: "custom", message: "payment interactions must be unique" });
  if (new Set(value.tools.map((tool) => tool.name)).size !== value.tools.length) context.addIssue({ code: "custom", message: "tools must be unique" });
  for (const tool of value.tools) {
    if (tool.available === tool.planned) context.addIssue({ code: "custom", message: `${tool.name} must be either available or planned` });
  }
  if (BigInt(value.topUpCap.minimum) > BigInt(value.topUpCap.maximum)) {
    context.addIssue({ code: "custom", message: "top-up minimum must not exceed maximum" });
  }
});

export type ContextVmAnnouncementInput = z.infer<typeof ContextVmAnnouncementInputSchema>;

export type ContextVmAnnouncement = Readonly<{
  tags: readonly (readonly string[])[];
  metadata: Readonly<{
    protocol: "contextvm-v1";
    topUp: Readonly<{ available: true; separateFromGenerationUsage: true; unit: "sat"; minimum: string; maximum: string }>;
    tools: readonly Readonly<{ name: z.infer<typeof ToolNameSchema>; available: boolean; planned: boolean; invocable: boolean }>[];
  }>;
}>;

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Canonical v1 discovery projection.  The returned `cap` advertises only the
 * separate top-up range; it has no account, hold, credit, or generation-price
 * authority.  The SDK bridge is the only caller that turns these tags into a
 * server-signed announcement.
 */
export function buildContextVmAnnouncement(input: unknown): ContextVmAnnouncement {
  const parsed = ContextVmAnnouncementInputSchema.parse(input);
  const tags = [
    ["cap", "top_up", `${parsed.topUpCap.minimum}-${parsed.topUpCap.maximum}`, parsed.topUpCap.unit],
    ...parsed.paymentInteraction.map((mode) => ["payment_interaction", mode]),
    ...parsed.pmis.map((pmi) => ["pmi", pmi]),
  ].sort((left, right) => left.join("\u0000").localeCompare(right.join("\u0000")));
  const tools = parsed.tools.map((tool) => ({
    ...tool,
    invocable: tool.available,
  })).sort((left, right) => left.name.localeCompare(right.name));

  return freeze({
    tags,
    metadata: {
      protocol: "contextvm-v1" as const,
      topUp: {
        available: true as const,
        separateFromGenerationUsage: true as const,
        unit: parsed.topUpCap.unit,
        minimum: parsed.topUpCap.minimum,
        maximum: parsed.topUpCap.maximum,
      },
      tools,
    },
  });
}
