import { ReleaseCertificationController, RELEASE_WORKSPACE_ENV, runReleaseCertification } from "../src/release/controller";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const defaultWorkspace = join(repositoryRoot, ".runtime", "release-certification");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function containedBy(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function controllerWorkspace(): string {
  const override = process.env[RELEASE_WORKSPACE_ENV];
  if (!override) return defaultWorkspace;
  if (!isAbsolute(override)) throw new Error("RELEASE_CERTIFICATION_WORKSPACE_REJECTED");
  const resolved = resolve(override);
  if (!containedBy(defaultWorkspace, resolved)) throw new Error("RELEASE_CERTIFICATION_WORKSPACE_REJECTED");
  return resolved;
}

async function main(): Promise<number> {
  const allowed = new Set(["--candidate", "--resume", "--dry-run", "--status"]);
  const supplied = process.argv.slice(2);
  if (supplied.some((value) => value.startsWith("--") && !allowed.has(value))) {
    console.error("RELEASE_CERTIFICATION_ARGUMENT_REJECTED");
    return 1;
  }
  const candidatePath = option("--candidate");
  const dryRun = process.argv.includes("--dry-run");
  const status = process.argv.includes("--status");
  const resume = option("--resume");
  if (!candidatePath || (dryRun && status) || (resume !== undefined && !/^[a-f0-9]{64}$/iu.test(resume))) {
    console.error("RELEASE_CERTIFICATION_USAGE");
    return 1;
  }
  try {
    const workspace = controllerWorkspace();
    const result = status
      ? await new ReleaseCertificationController({ candidatePath, workspace }).status()
      : await runReleaseCertification({ candidatePath, workspace, dryRun: true });
    if (!result) {
      console.error("RELEASE_CONTROLLER_STATUS_UNAVAILABLE");
      return 1;
    }
    if (resume && resume.toLowerCase() !== result.state.stateSha256 && resume.toLowerCase() !== result.authorizationRequest.resumeStateSha256) throw new Error("RELEASE_CERTIFICATION_RESUME_MISMATCH");
    console.log(JSON.stringify({ status: result.state.status, candidateSha256: result.state.candidate.candidateSha256, topologySha256: result.state.topologySha256, stateSha256: result.state.stateSha256, authorizationRequestSha256: result.authorizationRequest.authorizationRequestSha256, resumeStateSha256: result.authorizationRequest.resumeStateSha256 }));
    return result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "RELEASE_CONTROLLER_FAILED");
    return 1;
  }
}

process.exitCode = await main();
