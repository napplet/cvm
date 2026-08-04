import { mkdir, readFile, writeFile } from "node:fs/promises";
import { canonicalJson } from "../src/promotion/schema";
import {
  ModalWorkerConfigSchema,
  blockedModalProbeEvidence,
  runModalIsolationProbe,
  type ModalProbeEvidence,
} from "../src/worker-adapters/modal-worker";

const evidenceDirectory = "evidence/phase-02/provider";
const pointerPath = "evidence/phase-02/modal-probe.json";

async function writeEvidence(evidence: ModalProbeEvidence): Promise<void> {
  const content = `${canonicalJson(evidence)}\n`;
  const immutablePath = `${evidenceDirectory}/${evidence.evidenceSha256}.json`;
  await mkdir(evidenceDirectory, { recursive: true });
  try {
    await writeFile(immutablePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    if (await readFile(immutablePath, "utf8") !== content) throw new Error("provider evidence collision");
  }
  await writeFile(pointerPath, content, "utf8");
}

const configPath = process.env.NAPPLET_CVM_MODAL_PROBE_CONFIG;
let evidence: ModalProbeEvidence;
if (!configPath) {
  evidence = await blockedModalProbeEvidence();
} else {
  try {
    const config = ModalWorkerConfigSchema.parse(await Bun.file(configPath).json());
    if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
      evidence = await blockedModalProbeEvidence("MODAL_CREDENTIALS_MISSING");
    } else {
      evidence = await runModalIsolationProbe({ config });
    }
  } catch {
    evidence = await blockedModalProbeEvidence("PROVIDER_CONFIG_INVALID");
  }
}
await writeEvidence(evidence);
console.log(`${evidence.status}:${evidence.selection}:${evidence.evidenceSha256}`);
