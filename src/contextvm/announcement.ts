import { z } from "zod";
import { validatedAvailablePromotedCliSourceContract } from "../publication/napplet-cli-source-contract.js";

const ToolNameSchema = z.enum([
  "account_status",
  "top_up",
  "funded_admission",
  "approve_session_cap",
  "start_session",
  "revise_session",
  "resume_session",
  "prepare_resume",
  "resume_session_v2",
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
  }).strict()).min(8).max(12),
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

/**
 * The composition root owns invocability. Callers may describe their normal
 * tool registry, but preview and publication cannot be advertised merely by
 * configuration: their availability is overwritten by installed safe facades.
 */
export function configureContextVmToolAvailability(input: unknown, availability: Readonly<{ preview: boolean; publicationSourceContract?: unknown; sessionCaps?: boolean; pricedContinuation?: boolean }>): ContextVmAnnouncementInput {
  const parsed = ContextVmAnnouncementInputSchema.parse(input);
  const publication = Boolean(validatedAvailablePromotedCliSourceContract(availability.publicationSourceContract));
  return ContextVmAnnouncementInputSchema.parse({
    ...parsed,
    tools: [...parsed.tools,
      ...(availability.sessionCaps && !parsed.tools.some(tool => tool.name === "approve_session_cap") ? [{ name: "approve_session_cap" as const, available: true, planned: false }] : []),
      ...(availability.pricedContinuation && !parsed.tools.some(tool => tool.name === "prepare_resume") ? [{ name: "prepare_resume" as const, available: true, planned: false }, { name: "resume_session_v2" as const, available: true, planned: false }] : []),
    ].map((tool) => tool.name === "approve_session_cap"
      ? { ...tool, available: Boolean(availability.sessionCaps), planned: !availability.sessionCaps }
      : tool.name === "prepare_resume" || tool.name === "resume_session_v2"
        ? { ...tool, available: Boolean(availability.pricedContinuation), planned: !availability.pricedContinuation }
      : tool.name === "preview"
      ? { ...tool, available: availability.preview, planned: !availability.preview }
      : tool.name === "publication"
        ? { ...tool, available: publication, planned: !publication }
        : tool),
  });
}

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
