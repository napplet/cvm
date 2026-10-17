import { z } from "zod";

export const PublicationMetadataSchema = z.object({
  status: z.literal("ok"), artifactId: z.string(), version: z.number().int().positive(),
  title: z.string().min(1).max(120), description: z.string().min(1).max(500),
  capabilitiesKnown: z.boolean().optional(),
  basis: z.enum(["manifest", "project", "fallback"]),
  tags: z.array(z.array(z.string())),
  files: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number().int().nonnegative() })),
});
export type PublicationMetadata = z.infer<typeof PublicationMetadataSchema>;

/** Interpret declarations only. Absence of optional tags does not prove absence
 * of optional runtime calls in an older build. */
export function publicationCapabilities(tags: readonly string[][], capabilitiesKnown?: boolean) {
  const domains = (names: string[]) => [...new Set(tags.filter(tag => names.includes(tag[0]!)).map(tag => tag[1]?.trim()).filter((value): value is string => !!value))];
  return { required: domains(["requires", "R"]), optional: domains(["O"]), legacy: capabilitiesKnown === undefined ? tags.some(tag => tag[0] === "path") || !tags.some(tag => tag[0] === "R" || tag[0] === "O") : !capabilitiesKnown };
}
