import { writeSupplyChainRecord } from "../src/certification/supply-chain.js";

async function main(): Promise<void> {
  if (Bun.argv.length !== 2) { console.error(JSON.stringify({ phase: "07", command: "verify-supply-chain", status: "blocked", reason: "invalid_arguments" })); process.exitCode = 64; return; }
  const inputPath = process.env.PHASE07_BUILD_RECORDS_PATH;
  const executable = process.env.PHASE07_COSIGN_EXECUTABLE;
  const executableSha256 = process.env.PHASE07_COSIGN_SHA256;
  const directory = process.env.PHASE07_SUPPLY_CHAIN_EVIDENCE_DIRECTORY;
  if (!inputPath || !executable || !executableSha256 || !directory || !inputPath.startsWith("/") || !executable.startsWith("/") || !directory.startsWith("/") || !/^[a-f0-9]{64}$/iu.test(executableSha256)) {
    console.error(JSON.stringify({ phase: "07", command: "verify-supply-chain", status: "blocked", reason: "protected_configuration_unavailable" })); process.exitCode = 1; return;
  }
  try {
    const raw = await Bun.file(inputPath).json() as Record<string, unknown>;
    const record = await writeSupplyChainRecord(directory, { ...raw, cosign: { ...(raw.cosign as Record<string, unknown>), executable, executableSha256 } });
    console.log(JSON.stringify({ phase: "07", command: "verify-supply-chain", status: "verified", evidenceSha256: record.evidenceSha256 }));
  } catch {
    console.error(JSON.stringify({ phase: "07", command: "verify-supply-chain", status: "failed", reason: "protected_record_invalid" })); process.exitCode = 1;
  }
}
await main();
