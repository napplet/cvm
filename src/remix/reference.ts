import { z } from "zod";
export const RemixReferenceSchema = z.string().regex(/^remix:[a-f0-9]{64}$/u);
