import { z } from "zod";

/** Trusted controller metadata only. No signer, credentials, egress grant,
 * arbitrary CLI arguments or generated package configuration crosses here. */
export const ProductionWorkerPublicationSchema = z.object({
  server: z.string().url().max(512).refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  }, "PRODUCTION_PUBLICATION_ORIGIN_REQUIRED").transform(value => new URL(value).origin),
}).strict();
export type ProductionWorkerPublication = Readonly<z.infer<typeof ProductionWorkerPublicationSchema>>;
