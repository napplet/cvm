import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const AbsolutePathSchema = z.string().min(1).refine(isAbsolute, "path must be absolute");
const SourceRevisionSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu).transform((value) => value.toLowerCase());
const SecretReferenceSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,31}:[a-z][a-z0-9:._/-]{2,255}$/iu);

const DeploymentExecutionConfigSchema = z.object({
  version: z.literal(1),
  candidateSha256: DigestSchema,
  sourceRevision: SourceRevisionSchema,
  workspaceRoot: AbsolutePathSchema,
  factoryModuleSha256: DigestSchema,
  /** Digest of the separately pinned mounted ProductionConfig + material
   * constructor closure. It binds the runtime authority reviewed with this
   * candidate instead of letting receipt execution select a later module. */
  runtimeClosureSha256: DigestSchema.optional(),
  publicSettings: z.object({
    regions: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,62}$/u)).min(1).max(4),
    /** Product policy, not a CLI flag: a prepared run cannot extend beyond the
     * sealed worker lifetime and evidence/artifacts are retained for 30 days. */
    maximumRunDurationMs: z.number().int().positive().max(15 * 60 * 1_000).default(15 * 60 * 1_000),
    retentionDays: z.literal(30).default(30),
  }).strict(),
  secretReferences: z.record(z.string().regex(/^[a-z][a-z0-9A-Z]{2,63}$/u), SecretReferenceSchema).refine(
    (references) => Object.keys(references).length <= 16,
    "at most sixteen secret references",
  ),
}).strict();

export type DeploymentExecutionConfig = Readonly<z.infer<typeof DeploymentExecutionConfigSchema>>;

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Parses inert controller-owned configuration: references and bounded public
 * settings are permitted; secrets, native receipts, and ambient authority are not. */
export function createDeploymentExecutionConfig(input: unknown): DeploymentExecutionConfig {
  const config = DeploymentExecutionConfigSchema.parse(input);
  return freeze({
    ...config,
    workspaceRoot: resolve(config.workspaceRoot),
    publicSettings: { ...config.publicSettings, regions: [...config.publicSettings.regions] },
    secretReferences: { ...config.secretReferences },
  });
}
