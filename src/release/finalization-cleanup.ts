import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../promotion/schema";
import type { ReleaseFinalizationCleanupPort } from "./finalize";
import { claimFinalizationRecord as claim } from "./finalization-files";

export type FinalizationCleanupEffect = Readonly<{ providerOperationId: string; resourceIdentitySha256: string }>;
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

async function read(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (missing(error)) return undefined; throw error; }
}
async function immutable(path: string, value: unknown): Promise<void> {
  await claim(path, value);
}
function request(operationId: string, effect: FinalizationCleanupEffect) {
  return { operationId: `${operationId}:cleanup:${effect.providerOperationId}`, ...effect };
}
function terminal(value: unknown, expected: ReturnType<typeof request>): value is ReturnType<typeof request> & { version: 1; result: "cleaned" | "retained" } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && (record.result === "cleaned" || record.result === "retained")
    && canonicalJson(record) === canonicalJson({ version: 1, ...expected, result: record.result });
}

/** Claim before dispatch. A crash at any point after the claim can only be
 * recovered by observing that original provider operation. */
export async function completeFinalizationCleanup(input: Readonly<{
  root: string; operationId: string; bundleSha256: string;
  effects: readonly FinalizationCleanupEffect[]; port?: ReleaseFinalizationCleanupPort;
}>): Promise<boolean> {
  if (new Set(input.effects.map((effect) => effect.providerOperationId)).size !== input.effects.length) throw new Error("RELEASE_FINALIZATION_CLEANUP_PLAN_INVALID");
  await mkdir(join(input.root, "cleanup"), { recursive: true, mode: 0o700 });
  const receipts: string[] = [];
  for (const effect of input.effects) {
    const expected = request(input.operationId, effect);
    const path = join(input.root, "cleanup", `${digest(expected.operationId)}.json`);
    const stored = await read(path);
    if (stored !== undefined) {
      if (!terminal(stored, expected)) throw new Error("RELEASE_FINALIZATION_CLEANUP_COLLISION");
      receipts.push(digest(stored));
      continue;
    }
    if (!input.port) return false;
    const intent = { version: 1, ...expected };
    const claimed = await claim(`${path}.intent`, intent);
    let result: "cleaned" | "retained" | "unknown";
    try { result = claimed ? await input.port.cleanup(expected) : await input.port.observe?.(expected) ?? "unknown"; }
    catch { return false; }
    if (result !== "cleaned" && result !== "retained") return false;
    const receipt = { version: 1, ...expected, result };
    await immutable(path, receipt);
    receipts.push(digest(receipt));
  }
  await mkdir(join(input.root, "completed"), { recursive: true, mode: 0o700 });
  await immutable(join(input.root, "completed", `${input.bundleSha256}.json`), {
    version: 1, operationId: input.operationId, bundleSha256: input.bundleSha256,
    cleanupReceipts: receipts, status: "completed",
  });
  return true;
}

/** Read-only check of every original cleanup result and the completion index. */
export async function verifyFinalizationCleanup(input: Readonly<{
  root: string; operationId: string; bundleSha256: string; effects: readonly FinalizationCleanupEffect[];
}>): Promise<void> {
  const receipts: string[] = [];
  if (new Set(input.effects.map((effect) => effect.providerOperationId)).size !== input.effects.length) throw new Error("RELEASE_FINALIZATION_CLEANUP_PLAN_INVALID");
  for (const effect of input.effects) {
    const expected = request(input.operationId, effect);
    const value = await read(join(input.root, "cleanup", `${digest(expected.operationId)}.json`));
    if (!terminal(value, expected)) throw new Error("RELEASE_FINALIZATION_CLEANUP_INCOMPLETE");
    receipts.push(digest(value));
  }
  const completion = await read(join(input.root, "completed", `${input.bundleSha256}.json`));
  if (!completion || canonicalJson(completion) !== canonicalJson({ version: 1, operationId: input.operationId, bundleSha256: input.bundleSha256, cleanupReceipts: receipts, status: "completed" })) throw new Error("RELEASE_FINALIZATION_CLEANUP_INCOMPLETE");
}
