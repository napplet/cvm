import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { executePhase07ReferenceCase, validatePhase07ReferenceSet } from "../src/certification/phase-07-reference-set.js";
import { validatePhase07DesignEvidence, writePhase07DesignEvidence } from "../src/certification/evidence.js";

const directory = "evidence/design";

async function git(args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0) throw new Error("SOURCE_REVISION_UNAVAILABLE");
  return stdout.trim();
}

/** Generated evidence is intentionally unavailable from a dirty checkout: a
 * deterministic report must never pretend to describe a clean candidate. */
async function cleanHeadRevision(): Promise<string> {
  // `diff --quiet` misses untracked files. Claim-bearing evidence may only be
  // written from a fully clean checkout, including index and untracked state.
  if (await git(["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("SOURCE_TREE_DIRTY");
  const revision = await git(["rev-parse", "HEAD"]);
  await git(["cat-file", "-e", `${revision}^{commit}`]);
  return revision;
}

async function main(): Promise<void> {
  const [argument] = Bun.argv.slice(2);
  if (Bun.argv.length > 3 || (argument && argument !== "--verify-existing")) { console.error(JSON.stringify({ phase: "07", command: "verify-evidence", status: "failed", reason: "invalid_arguments" })); process.exitCode = 64; return; }
  try {
    if (argument === "--verify-existing") {
      const pointer = JSON.parse(await readFile(join(directory, "phase-07.json"), "utf8")) as { contentAddressedPath?: string; evidenceSha256?: string };
      if (typeof pointer.contentAddressedPath !== "string" || typeof pointer.evidenceSha256 !== "string") throw new Error("pointer_invalid");
      const evidence = await validatePhase07DesignEvidence(JSON.parse(await readFile(pointer.contentAddressedPath, "utf8")));
      if (evidence.evidenceSha256 !== pointer.evidenceSha256) throw new Error("pointer_digest_invalid");
      console.log(JSON.stringify({ phase: "07", command: "verify-evidence", status: "passed", mode: "verify-existing", offlineVerdict: evidence.offlineVerdict, promotionVerdict: evidence.promotionVerdict }));
      return;
    }
    const fixture = validatePhase07ReferenceSet(await Bun.file("tests/fixtures/phase-07-reference-set.json").json());
    const comparisons = await Promise.all(fixture.cases.map((item) => executePhase07ReferenceCase(item)));
    const evidence = await writePhase07DesignEvidence(directory, { fixture, comparisons, sourceRevision: await cleanHeadRevision() });
    const reread = await validatePhase07DesignEvidence(JSON.parse(await readFile(evidence.contentAddressedPath, "utf8")));
    if (reread.evidenceSha256 !== evidence.evidenceSha256) throw new Error("record_reread_invalid");
    console.log(JSON.stringify({ phase: "07", command: "verify-evidence", status: "passed", mode: "build", evidenceSha256: evidence.evidenceSha256, offlineVerdict: evidence.offlineVerdict, promotionVerdict: evidence.promotionVerdict }));
  } catch (error) { console.error(JSON.stringify({ phase: "07", command: "verify-evidence", status: "failed", reason: error instanceof Error ? error.message : "unknown" })); process.exitCode = 1; }
}
await main();
