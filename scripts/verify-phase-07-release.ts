import { loadPinnedReleaseCertificationTrustRoot } from "../src/certification/trust.js";
import { verifyReleaseCertificationBundle } from "../src/promotion/candidate.js";

type ProtectedConfiguration = Readonly<{ root: string; modulePath: string; sha256: string }>;

function protectedConfiguration(): ProtectedConfiguration | null {
  const root = process.env.PHASE07_RELEASE_TRUST_ROOT_DIRECTORY;
  const modulePath = process.env.PHASE07_RELEASE_TRUST_ROOT;
  const sha256 = process.env.PHASE07_RELEASE_TRUST_ROOT_SHA256;
  if (!root || !modulePath || !sha256 || !root.startsWith("/") || !modulePath.startsWith("/") || !/^[a-f0-9]{64}$/iu.test(sha256)) return null;
  return { root, modulePath, sha256 };
}

function blocked(reason: "invalid_arguments" | "protected_configuration_unavailable" | "protected_trust_root_rejected"): void {
  console.error(JSON.stringify({ phase: "07", command: "verify-release-protected", status: "blocked", reason }));
  process.exitCode = reason === "invalid_arguments" ? 64 : 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--release-evidence" || args[1]!.startsWith("-") || args[1]!.startsWith("/") || args[1]!.split("/").includes("..")) {
    blocked("invalid_arguments");
    return;
  }
  const configuration = protectedConfiguration();
  if (!configuration) {
    blocked("protected_configuration_unavailable");
    return;
  }
  try {
    // This is intentionally before any release-bundle read: candidate bytes
    // cannot select, replace, or execute the certifier authority.
    const trustRoot = await loadPinnedReleaseCertificationTrustRoot(configuration);
    const decision = await verifyReleaseCertificationBundle(args[1]!, trustRoot);
    console.log(JSON.stringify(decision));
    process.exitCode = decision.status === "promoted" ? 0 : 1;
  } catch {
    blocked("protected_trust_root_rejected");
  }
}

await main();
