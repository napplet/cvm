import { z } from "zod";

export const NAPPLET_CLI_SOURCE_COMMIT = "1a38b9150f3a3da148091c11bce4d0365f7298e5" as const;
export const NAPPLET_CLI_LINUX_SHA256 = "46685f2e4df516b5b2e7e2e133480c90e5c85dbd36d05c6e95f4eee6af33ec5e" as const;

const SHA256 = z.string().regex(/^[a-f0-9]{64}$/iu);
const SOURCE_FILE_HASHES = {
  "deploy-network.ts": "b28dd1966718512617c139aaede77b3ed9a4b46cfbd7a2bb642eb046c46c4440",
  "blossom-upload.ts": "078970ea91ff2d7f35c7d45798ad05232a082ea6a124424069aae70dbf74e71e",
  "types.ts": "18c313d152bd4e2eb4f382d16f60bd361212566e42091f8bf27b9dd6df800f10",
  "cli.ts": "bc1ae1fc5919a5d6a4b4ace181989915090f18ae1b409193ba11dc4e516ca430",
  "deploy-plan.ts": "d53317627c99ab38aa702d9218c243d387250a7252ccc31866d2cb989d7e4ac8",
  "signing.ts": "be5bbc8205227ae09447e87fb0e7d6f0da5f12da6b94601e8609f98b991ef858",
  "discover.ts": "eeb7667d815367377811ac8d909ebee6ebe2fde33002d869335f446fb64a67e9",
  "manifest.ts": "74b9f5f13079cf451412c30c7ad944e445d31e07a46826792ec0d6b78a30f0a8",
} as const;

const REQUIRED_EXPORTS = [
  "DeployFilePayload", "ServerUploadResult", "RelayPublishResult", "NetworkDeployProgress", "NetworkDeployResult",
  "uploadFilesToServers", "publishEventWithSimplePool", "networkDeploySucceeded",
] as const;
const REJECTED_ROUTES = [
  "collectDeployFilePayloads", "executeNetworkDeploy", "createDeployPlan", "discoverNapplets",
  "createDeployManifestTemplates", "signDeployManifestTemplates", "createDeploySigner", "resolveSigningMethod",
  "main", "root_manifest", "snapshot_manifest", "multi_target", "dependency_build_prebuilt_rebuild", "dry_run_json_stdout",
] as const;

const PromotedCliSourceIdentitySchema = z.object({
  version: z.literal("0.5.2"),
  sourceCommit: z.literal(NAPPLET_CLI_SOURCE_COMMIT),
  linuxSha256: z.literal(NAPPLET_CLI_LINUX_SHA256),
}).strict();
const PromotedCliSourceFilesSchema = z.object(Object.fromEntries(Object.entries(SOURCE_FILE_HASHES).map(([file, hash]) => [file, z.literal(hash)])) as Record<keyof typeof SOURCE_FILE_HASHES, z.ZodLiteral<string>>).strict();
const PromotedCliSourceSurfaceSchema = z.object({
  requiredExports: z.array(z.string()).max(REQUIRED_EXPORTS.length),
  rejectedRoutes: z.array(z.string()).max(REJECTED_ROUTES.length),
}).strict();

export const PromotedCliSourceSnapshotSchema = z.object({
  identity: PromotedCliSourceIdentitySchema,
  sourceFiles: PromotedCliSourceFilesSchema,
  requiredExports: PromotedCliSourceSurfaceSchema.shape.requiredExports,
  rejectedRoutes: PromotedCliSourceSurfaceSchema.shape.rejectedRoutes,
  liveExecution: z.literal("not_observed"),
}).strict();
export type PromotedCliSourceSnapshot = Readonly<z.infer<typeof PromotedCliSourceSnapshotSchema>>;

const UnavailableReasonSchema = z.enum([
  "SOURCE_SNAPSHOT_INVALID", "PROMOTED_IDENTITY_MISMATCH", "SOURCE_FILE_HASH_MISMATCH", "STRUCTURED_ROUTE_UNAVAILABLE", "UNSAFE_ROUTE_NOT_REJECTED",
]);
export const PromotedCliSourceContractResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    liveExecution: z.literal("not_observed"),
    // Keep every source fact in the result. Every downstream trust boundary
    // revalidates this exact provenance rather than trusting `status` alone.
    identity: PromotedCliSourceIdentitySchema,
    sourceFiles: PromotedCliSourceFilesSchema,
    surface: PromotedCliSourceSurfaceSchema,
  }).strict(),
  z.object({ status: z.literal("publication_unavailable"), liveExecution: z.literal("not_observed"), reasonCode: UnavailableReasonSchema }).strict(),
]);
export type PromotedCliSourceContractResult = Readonly<z.infer<typeof PromotedCliSourceContractResultSchema>>;

function unavailable(reasonCode: z.infer<typeof UnavailableReasonSchema>): PromotedCliSourceContractResult {
  return PromotedCliSourceContractResultSchema.parse({ status: "publication_unavailable", liveExecution: "not_observed", reasonCode });
}

function exactSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value) => expected.includes(value)) && new Set(actual).size === actual.length;
}

export type AvailablePromotedCliSourceContract = Extract<PromotedCliSourceContractResult, { status: "available" }>;

/**
 * The sole authority for turning an untrusted source-contract result into an
 * eligible publication capability. Structural `available` values are never
 * enough: the full pinned identity, source-hash provenance, and closed source
 * surface must all remain exact at the consuming boundary.
 */
export function validatedAvailablePromotedCliSourceContract(input: unknown): AvailablePromotedCliSourceContract | undefined {
  const parsed = PromotedCliSourceContractResultSchema.safeParse(input);
  if (!parsed.success || parsed.data.status !== "available") return undefined;
  if (!exactSet(parsed.data.surface.requiredExports, REQUIRED_EXPORTS) || !exactSet(parsed.data.surface.rejectedRoutes, REJECTED_ROUTES)) return undefined;
  return PromotedCliSourceContractResultSchema.parse(parsed.data) as AvailablePromotedCliSourceContract;
}

/**
 * Validates only the reviewed source facts. It neither resolves the standalone binary nor
 * executes a signer, upload, relay, build, manifest, or command path.
 */
export function probePromotedCliPreSignedRoute(snapshot: unknown): PromotedCliSourceContractResult {
  const parsed = PromotedCliSourceSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    const input = snapshot as { identity?: { sourceCommit?: unknown; linuxSha256?: unknown }; sourceFiles?: unknown } | null;
    if (input?.identity?.sourceCommit !== NAPPLET_CLI_SOURCE_COMMIT || input?.identity?.linuxSha256 !== NAPPLET_CLI_LINUX_SHA256) return unavailable("PROMOTED_IDENTITY_MISMATCH");
    if (input?.sourceFiles && typeof input.sourceFiles === "object") return unavailable("SOURCE_FILE_HASH_MISMATCH");
    return unavailable("SOURCE_SNAPSHOT_INVALID");
  }
  if (!exactSet(parsed.data.requiredExports, REQUIRED_EXPORTS)) return unavailable("STRUCTURED_ROUTE_UNAVAILABLE");
  if (!exactSet(parsed.data.rejectedRoutes, REJECTED_ROUTES)) return unavailable("UNSAFE_ROUTE_NOT_REJECTED");
  return PromotedCliSourceContractResultSchema.parse({
    status: "available",
    liveExecution: "not_observed",
    identity: { version: "0.5.2", sourceCommit: NAPPLET_CLI_SOURCE_COMMIT, linuxSha256: NAPPLET_CLI_LINUX_SHA256 },
    sourceFiles: { ...SOURCE_FILE_HASHES },
    surface: { requiredExports: [...REQUIRED_EXPORTS], rejectedRoutes: [...REJECTED_ROUTES] },
  });
}

export const PROMOTED_CLI_SOURCE_FILE_HASHES = SOURCE_FILE_HASHES;
export const PROMOTED_CLI_REQUIRED_EXPORTS = REQUIRED_EXPORTS;
export const PROMOTED_CLI_REJECTED_ROUTES = REJECTED_ROUTES;
export const PromotedCliSourceFileHashSchema = SHA256;
