import { z } from "zod";

export function normalizeHashtag(input: string): string {
  const value = input.trim().normalize("NFKC").replace(/^#/, "").toLowerCase();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}\p{M}_-]{0,63}$/u.test(value)) throw new Error("Use 1–64 letters, numbers, hyphens or underscores, without spaces.");
  return value;
}
export const PublicationHashtagsSchema = z.array(z.string().max(128).transform((value, context) => {
  try { return normalizeHashtag(value); }
  catch { context.addIssue({ code: "custom", message: "Invalid hashtag" }); return z.NEVER; }
})).max(10).transform(values => [...new Set(values)]);
