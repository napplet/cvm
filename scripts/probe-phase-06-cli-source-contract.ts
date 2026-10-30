import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import fixture from "../tests/fixtures/phase-06-cli-source-contract.json" with { type: "json" };
import { NAPPLET_CLI_LINUX_SHA256, NAPPLET_CLI_SOURCE_COMMIT, PROMOTED_CLI_SOURCE_FILE_HASHES, probePromotedCliPreSignedRoute } from "../src/publication/napplet-cli-source-contract.js";

type Output = Readonly<{ status: "available" | "publication_unavailable"; liveExecution: "not_observed"; reasonCode?: string; surface?: unknown }>;
const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer)), (byte) => byte.toString(16).padStart(2, "0")).join("");

async function findNamedFiles(root: string, names: readonly string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && names.includes(entry.name) && !found.has(entry.name)) found.set(entry.name, path);
    }
  };
  await visit(root);
  return found;
}

async function checkedSnapshot(): Promise<Output> {
  if (fixture.identity.sourceCommit !== NAPPLET_CLI_SOURCE_COMMIT || fixture.identity.linuxSha256 !== NAPPLET_CLI_LINUX_SHA256) return { status: "publication_unavailable", liveExecution: "not_observed", reasonCode: "PROMOTED_RELEASE_SET_MISMATCH" };
  const checkout = process.env.NAPPLET_CLI_SOURCE_CHECKOUT;
  if (!checkout) return { status: "publication_unavailable", liveExecution: "not_observed", reasonCode: "SOURCE_CHECKOUT_NOT_PROVIDED" };
  try {
    const files = await findNamedFiles(checkout, Object.keys(PROMOTED_CLI_SOURCE_FILE_HASHES));
    for (const [name, expected] of Object.entries(PROMOTED_CLI_SOURCE_FILE_HASHES)) {
      const path = files.get(name);
      if (!path || await digest(await readFile(path)) !== expected) return { status: "publication_unavailable", liveExecution: "not_observed", reasonCode: "SOURCE_FILE_HASH_MISMATCH" };
    }
  } catch {
    return { status: "publication_unavailable", liveExecution: "not_observed", reasonCode: "SOURCE_CHECKOUT_UNREADABLE" };
  }
  return probePromotedCliPreSignedRoute(fixture);
}

const output = await checkedSnapshot();
process.stdout.write(`${JSON.stringify(output)}\n`);
