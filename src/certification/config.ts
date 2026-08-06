import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const AbsolutePathSchema = z.string().min(1).refine(isAbsolute, "path must be absolute");
const PinnedModuleSchema = z.object({
  root: AbsolutePathSchema,
  modulePath: AbsolutePathSchema,
  sha256: DigestSchema,
}).strict();

const LocalCertifierConfigSchema = z.object({
  version: z.literal(1),
  mode: z.literal("local"),
  evidenceDirectory: z.string().min(1).optional(),
}).strict();

const ProtectedCertifierConfigSchema = z.object({
  version: z.literal(1),
  mode: z.literal("protected"),
  releaseProfilePath: AbsolutePathSchema,
  evidenceDirectory: AbsolutePathSchema,
  credentials: z.enum(["configured", "unavailable"]),
  adapter: PinnedModuleSchema,
  trustRoot: PinnedModuleSchema,
  reproducibility: z.object({
    buildRecordsPath: AbsolutePathSchema,
    evidenceDirectory: AbsolutePathSchema,
  }).strict().optional(),
  supplyChain: z.object({
    buildRecordsPath: AbsolutePathSchema,
    cosignExecutable: AbsolutePathSchema,
    cosignSha256: DigestSchema,
    evidenceDirectory: AbsolutePathSchema,
  }).strict().optional(),
}).strict();

const CertifierConfigSchema = z.discriminatedUnion("mode", [LocalCertifierConfigSchema, ProtectedCertifierConfigSchema]);
type ParsedCertifierConfig = z.infer<typeof CertifierConfigSchema>;
export type PinnedCertifierModule = z.infer<typeof PinnedModuleSchema>;
export type ProtectedCertifierConfig = z.infer<typeof ProtectedCertifierConfigSchema>;
export type CertifierConfig = ProtectedCertifierConfig | Readonly<{
  version: 1;
  mode: "local";
  evidenceDirectory: string;
}>;

export const CERTIFIER_CONFIG_ENV = "NAPPLET_CVM_CERTIFIER_CONFIG";
export const CERTIFIER_CONFIG_SHA256_ENV = "NAPPLET_CVM_CERTIFIER_CONFIG_SHA256";

async function sha256(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const defaultLocalConfig = (): CertifierConfig => ({
  version: 1,
  mode: "local",
  evidenceDirectory: resolve(tmpdir(), "napplet-cvm-certification-local"),
});

/**
 * Loads the single product-level certifier configuration boundary.
 *
 * Local mode is deliberately authority-free and needs no hash or credentials.
 * Protected mode requires an absolute config path plus an out-of-band SHA-256
 * pin before any adapter, trust root, release profile, or evidence path is used.
 */
export async function loadCertifierConfig(input: Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}> = {}): Promise<CertifierConfig> {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const configuredPath = env[CERTIFIER_CONFIG_ENV];
  if (!configuredPath) return defaultLocalConfig();

  try {
    const configPath = resolve(cwd, configuredPath);
    const bytes = await readFile(configPath);
    const parsed = CertifierConfigSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) as ParsedCertifierConfig;
    if (parsed.mode === "local") {
      return {
        ...parsed,
        evidenceDirectory: parsed.evidenceDirectory
          ? resolve(dirname(configPath), parsed.evidenceDirectory)
          : defaultLocalConfig().evidenceDirectory,
      };
    }

    const expectedSha256 = env[CERTIFIER_CONFIG_SHA256_ENV];
    if (!isAbsolute(configuredPath) || !expectedSha256 || !DigestSchema.safeParse(expectedSha256).success || await sha256(bytes) !== expectedSha256.toLowerCase()) {
      throw new Error("CERTIFIER_CONFIG_PIN_REJECTED");
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === "CERTIFIER_CONFIG_PIN_REJECTED") throw error;
    throw new Error("CERTIFIER_CONFIG_INVALID");
  }
}
