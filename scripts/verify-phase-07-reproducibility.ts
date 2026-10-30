import { verifyReproducibilityRecord, writeReproducibilityRecord } from "../src/certification/reproducibility.js";
import { loadPinnedReleaseCertificationTrustRoot } from "../src/certification/trust.js";
import { loadCertifierConfig } from "../src/certification/config.js";

async function main(): Promise<void> {
  if (Bun.argv.length !== 2) { console.error(JSON.stringify({ phase: "07", command: "verify-reproducibility", status: "blocked", reason: "invalid_arguments" })); process.exitCode = 64; return; }
  let config;
  try { config = await loadCertifierConfig(); } catch { config = null; }
  if (!config || config.mode !== "protected" || !config.trustRoot || !config.reproducibility) {
    console.error(JSON.stringify({ phase: "07", command: "verify-reproducibility", status: "blocked", reason: "protected_configuration_unavailable" })); process.exitCode = 1; return;
  }
  try {
    const input = await Bun.file(config.reproducibility.buildRecordsPath).json();
    const trustRoot = await loadPinnedReleaseCertificationTrustRoot(config.trustRoot);
    const record = await verifyReproducibilityRecord(input, { trustRoot });
    await writeReproducibilityRecord(config.reproducibility.evidenceDirectory, input, { trustRoot });
    console.log(JSON.stringify({ phase: "07", command: "verify-reproducibility", status: "verified", evidenceSha256: record.evidenceSha256 }));
  } catch {
    console.error(JSON.stringify({ phase: "07", command: "verify-reproducibility", status: "failed", reason: "protected_record_invalid" })); process.exitCode = 1;
  }
}
await main();
