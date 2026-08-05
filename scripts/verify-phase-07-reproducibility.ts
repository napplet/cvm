import { verifyReproducibilityRecord, writeReproducibilityRecord } from "../src/certification/reproducibility.js";
import { loadPinnedReleaseCertificationTrustRoot } from "../src/certification/trust.js";

async function main(): Promise<void> {
  if (Bun.argv.length !== 2) { console.error(JSON.stringify({ phase: "07", command: "verify-reproducibility", status: "blocked", reason: "invalid_arguments" })); process.exitCode = 64; return; }
  const recordsPath = process.env.PHASE07_BUILD_RECORDS_PATH;
  const outputDirectory = process.env.PHASE07_REPRODUCIBILITY_EVIDENCE_DIRECTORY;
  const trustRootDirectory = process.env.PHASE07_REPRODUCIBILITY_TRUST_ROOT_DIRECTORY;
  const trustRootPath = process.env.PHASE07_REPRODUCIBILITY_TRUST_ROOT;
  const trustRootSha256 = process.env.PHASE07_REPRODUCIBILITY_TRUST_ROOT_SHA256;
  if (!recordsPath || !outputDirectory || !trustRootDirectory || !trustRootPath || !trustRootSha256
    || !recordsPath.startsWith("/") || !outputDirectory.startsWith("/") || !trustRootDirectory.startsWith("/") || !trustRootPath.startsWith("/") || !/^[a-f0-9]{64}$/iu.test(trustRootSha256)) {
    console.error(JSON.stringify({ phase: "07", command: "verify-reproducibility", status: "blocked", reason: "protected_configuration_unavailable" })); process.exitCode = 1; return;
  }
  try {
    const input = await Bun.file(recordsPath).json();
    const trustRoot = await loadPinnedReleaseCertificationTrustRoot({ root: trustRootDirectory, modulePath: trustRootPath, sha256: trustRootSha256 });
    const record = await verifyReproducibilityRecord(input, { trustRoot });
    await writeReproducibilityRecord(outputDirectory, input, { trustRoot });
    console.log(JSON.stringify({ phase: "07", command: "verify-reproducibility", status: "verified", evidenceSha256: record.evidenceSha256 }));
  } catch {
    console.error(JSON.stringify({ phase: "07", command: "verify-reproducibility", status: "failed", reason: "protected_record_invalid" })); process.exitCode = 1;
  }
}
await main();
