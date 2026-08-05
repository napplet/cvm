import { verifyReproducibilityRecord, writeReproducibilityRecord } from "../src/certification/reproducibility.js";

async function main(): Promise<void> {
  if (Bun.argv.length !== 2) { console.error(JSON.stringify({ phase: "07", command: "verify-reproducibility", status: "blocked", reason: "invalid_arguments" })); process.exitCode = 64; return; }
  const recordsPath = process.env.PHASE07_BUILD_RECORDS_PATH;
  const outputDirectory = process.env.PHASE07_REPRODUCIBILITY_EVIDENCE_DIRECTORY;
  if (!recordsPath || !outputDirectory || !recordsPath.startsWith("/") || !outputDirectory.startsWith("/")) {
    console.error(JSON.stringify({ phase: "07", command: "verify-reproducibility", status: "blocked", reason: "protected_configuration_unavailable" })); process.exitCode = 1; return;
  }
  try {
    const input = await Bun.file(recordsPath).json();
    const record = await verifyReproducibilityRecord(input);
    await writeReproducibilityRecord(outputDirectory, input);
    console.log(JSON.stringify({ phase: "07", command: "verify-reproducibility", status: "verified", evidenceSha256: record.evidenceSha256 }));
  } catch {
    console.error(JSON.stringify({ phase: "07", command: "verify-reproducibility", status: "failed", reason: "protected_record_invalid" })); process.exitCode = 1;
  }
}
await main();
