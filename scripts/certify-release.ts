import { ReleaseCertificationController, RELEASE_WORKSPACE_ENV, runReleaseCertification } from "../src/release/controller";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const candidatePath = option("--candidate");
  const workspace = option("--workspace") ?? process.env[RELEASE_WORKSPACE_ENV];
  const dryRun = process.argv.includes("--dry-run");
  const status = process.argv.includes("--status");
  if (!workspace || (!candidatePath && !status) || (dryRun === status)) {
    console.error("RELEASE_CERTIFICATION_USAGE");
    return 1;
  }
  try {
    const result = status
      ? await new ReleaseCertificationController({ candidatePath: candidatePath ?? ".", workspace }).status()
      : await runReleaseCertification({ candidatePath: candidatePath!, workspace, dryRun: true });
    if (!result) {
      console.error("RELEASE_CONTROLLER_STATUS_UNAVAILABLE");
      return 1;
    }
    console.log(JSON.stringify({ status: result.state.status, stateSha256: result.state.stateSha256, authorizationRequestSha256: result.authorizationRequest.authorizationRequestSha256, resumeStateSha256: result.authorizationRequest.resumeStateSha256 }));
    return result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "RELEASE_CONTROLLER_FAILED");
    return 1;
  }
}

process.exitCode = await main();
