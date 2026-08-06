import { writeSupplyChainRecord } from "../src/certification/supply-chain.js";
import { loadCertifierConfig } from "../src/certification/config.js";

async function main(): Promise<void> {
  if (Bun.argv.length !== 2) { console.error(JSON.stringify({ phase: "07", command: "verify-supply-chain", status: "blocked", reason: "invalid_arguments" })); process.exitCode = 64; return; }
  let config;
  try { config = await loadCertifierConfig(); } catch { config = null; }
  if (!config || config.mode !== "protected" || !config.supplyChain) {
    console.error(JSON.stringify({ phase: "07", command: "verify-supply-chain", status: "blocked", reason: "protected_configuration_unavailable" })); process.exitCode = 1; return;
  }
  try {
    const raw = await Bun.file(config.supplyChain.buildRecordsPath).json() as Record<string, unknown>;
    const record = await writeSupplyChainRecord(config.supplyChain.evidenceDirectory, { ...raw, cosign: { ...(raw.cosign as Record<string, unknown>), executable: config.supplyChain.cosignExecutable, executableSha256: config.supplyChain.cosignSha256 } });
    console.log(JSON.stringify({ phase: "07", command: "verify-supply-chain", status: "verified", evidenceSha256: record.evidenceSha256 }));
  } catch {
    console.error(JSON.stringify({ phase: "07", command: "verify-supply-chain", status: "failed", reason: "protected_record_invalid" })); process.exitCode = 1;
  }
}
await main();
