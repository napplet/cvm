import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { z } from "zod";
import { bindAccountingRealmPool, createAccountingRealm } from "../funding/accounting-realm";
import type { PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { canonicalJson } from "../promotion/schema";
import { loadCertifierConfig, type ProtectedCertifierConfig } from "../certification/config";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const FinalVerificationAuthoritySchema = z.object({ path: z.string().max(4096).refine(isAbsolute), sha256: Digest }).strict();
export type FinalVerificationAuthority = z.infer<typeof FinalVerificationAuthoritySchema>;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
/** Stable across candidates and receipts, while scoped to the selected SQL authority. */
export function productionReleaseScope(config: Readonly<{ projectId: string; cloudSql: Readonly<{ instanceReference: string; database: string }> }>): string {
  return hash({ version: 1, projectId: config.projectId, instanceReference: config.cloudSql.instanceReference, database: config.cloudSql.database });
}
const Promoted = z.object({ version: z.literal(1), candidateId: Digest, topologySha256: Digest, authorizationReceiptSha256: Digest,
  operationId: z.string().regex(/^promotion-[a-f0-9]{64}$/u), bundleSha256: Digest, expectedPreviousBundleSha256: Digest.nullable(),
  verificationAuthority: FinalVerificationAuthoritySchema, status: z.literal("promoted") }).strict();

/** SQL is the independently controlled authority for the final config pin.
 * This resolver never reads a verifier path/digest out of the supplied bundle.
 * It opens no model, wallet, worker, signer or relay clients. */
export async function loadPromotedVerificationAuthority(input: Readonly<{
  pool: PostgresSqlPool; deploymentScopeSha256: string; workspace: string; bundleSha256: string;
  candidateId?: string; topologySha256?: string;
}>): Promise<Readonly<{ config: ProtectedCertifierConfig; configSha256: string }>> {
  Digest.parse(input.deploymentScopeSha256); Digest.parse(input.bundleSha256); if (input.candidateId !== undefined) Digest.parse(input.candidateId); if (input.topologySha256 !== undefined) Digest.parse(input.topologySha256);
  const pool = bindAccountingRealmPool(input.pool, createAccountingRealm("production-real"));
  const client = await pool.connect();
  let row: Record<string, unknown>;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query("SELECT identity_sha256,value_json FROM production_real.release_operation_journal WHERE namespace='release-promotion' AND scope_sha256=$1 AND operation_id <> 'current' AND value_json->>'bundleSha256'=$2 LIMIT 2", [input.deploymentScopeSha256, input.bundleSha256]);
    if (result.rows.length !== 1) throw new Error("PRODUCTION_VERIFICATION_AUTHORITY_UNAVAILABLE");
    row = result.rows[0]!;
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
  const promoted = Promoted.parse(row.value_json);
  const { status: _status, ...identity } = promoted;
  if (row.identity_sha256 !== hash(identity) || (input.candidateId !== undefined && promoted.candidateId !== input.candidateId) || (input.topologySha256 !== undefined && promoted.topologySha256 !== input.topologySha256)
    || promoted.bundleSha256 !== input.bundleSha256 || promoted.operationId !== `promotion-${hash({ candidateId: promoted.candidateId, bundleSha256: promoted.bundleSha256, authorizationReceiptSha256: promoted.authorizationReceiptSha256 })}`) throw new Error("PRODUCTION_VERIFICATION_AUTHORITY_BINDING_INVALID");
  const workspace = await realpath(resolve(input.workspace));
  const suppliedPath = resolve(promoted.verificationAuthority.path);
  const suppliedRoot = resolve(input.workspace);
  const path = suppliedPath.startsWith(suppliedRoot + "/") ? resolve(workspace, relative(suppliedRoot, suppliedPath)) : suppliedPath;
  const expectedParent = join(workspace, "certifier-materializations", promoted.candidateId);
  const suffix = path.slice(expectedParent.length);
  if (!path.startsWith(expectedParent + "/") || !/^\/[a-f0-9]{64}\/final\/certifier\.json$/u.test(suffix)) throw new Error("PRODUCTION_VERIFICATION_AUTHORITY_PATH_INVALID");
  let current = workspace;
  for (const part of path.slice(workspace.length + 1).split("/")) {
    current = join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || (current === path ? !entry.isFile() || entry.size > 1_048_576 : !entry.isDirectory())) throw new Error("PRODUCTION_VERIFICATION_AUTHORITY_PATH_INVALID");
  }
  if (await realpath(path) !== path) throw new Error("PRODUCTION_VERIFICATION_AUTHORITY_PATH_INVALID");
  const bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== promoted.verificationAuthority.sha256) throw new Error("PRODUCTION_VERIFICATION_AUTHORITY_PIN_INVALID");
  const config = await loadCertifierConfig({ env: { NAPPLET_CVM_CERTIFIER_CONFIG: path, NAPPLET_CVM_CERTIFIER_CONFIG_SHA256: promoted.verificationAuthority.sha256 } });
  if (config.mode !== "protected" || !config.trustRoot || config.controller?.candidateId !== promoted.candidateId || config.controller.topologySha256 !== promoted.topologySha256 || config.controller.authorizationReceiptSha256 !== promoted.authorizationReceiptSha256) throw new Error("PRODUCTION_VERIFICATION_AUTHORITY_BINDING_INVALID");
  return Object.freeze({ config, configSha256: promoted.verificationAuthority.sha256 });
}
