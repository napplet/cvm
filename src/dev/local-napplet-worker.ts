import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { StoredSourceProposal } from "./source-proposal-store";

const image = process.env.NAPPLET_CVM_DEV_WORKER_IMAGE ?? "napplet-cvm/dev-worker:development";
export type WorkerOutput = Readonly<{ distRoot: string; toolchainSha256: string; commandEvidence: readonly Readonly<{ name: "create" | "init" | "skills" | "install" | "build" | "verify" | "conformance" | "dry-run"; exitCode: number; stdout?: string; stderr?: string }>[]; cleanup(): Promise<void> }>;

/** Model-free, closed-command worker. It receives a persisted proposal, never provider authority. */
export class LocalNappletWorker {
  constructor(private readonly input: Readonly<{ dockerBin?: string; image?: string }> = {}) {}
  async materialize(proposal: StoredSourceProposal): Promise<WorkerOutput> {
    const workspace = await mkdtemp(join(tmpdir(), "napplet-cvm-worker-"));
    const input = resolve(workspace, "input"); const output = resolve(workspace, "output");
    await mkdir(input); await mkdir(output); await chmod(output, 0o777);
    await writeFile(join(input, "proposal.json"), JSON.stringify({ proposalSha256: proposal.proposalSha256, files: proposal.proposal.files }));
    const docker = this.input.dockerBin ?? "docker"; const selectedImage = this.input.image ?? image;
    const inspect = Bun.spawn([docker, "image", "inspect", selectedImage, "--format", "{{.Id}}|{{.Os}}|{{.Architecture}}"], { stdout: "pipe", stderr: "pipe" });
    const [inspectCode, inspectOut] = await Promise.all([inspect.exited, new Response(inspect.stdout).text()]);
    const [imageId, os, arch] = inspectOut.trim().split("|");
    if (inspectCode !== 0 || !/^sha256:[a-f0-9]{64}$/u.test(imageId ?? "") || os !== "linux" || arch !== "arm64") { await rm(workspace, { recursive: true, force: true }); throw new Error("WORKER_IMAGE_PRECONDITION_FAILED"); }
    const args = ["run", "--rm", "--network", "none", "--read-only", "--user", "65532:65532", "--cpus", "2", "--memory", "2g", "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=256m", "--tmpfs", "/work:rw,exec,nosuid,nodev,size=512m", "--tmpfs", "/home/napplet:rw,exec,nosuid,nodev,size=128m", "-v", `${input}:/input:ro`, "-v", `${output}:/output:rw`, selectedImage, "/usr/local/bin/run-proposal"];
    const child = Bun.spawn([docker, ...args], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    let evidence: WorkerOutput["commandEvidence"] = [];
    try { evidence = JSON.parse(await readFile(join(output, "report.json"), "utf8")).stages.map((stage: any) => ({ name: stage.name, exitCode: stage.exitCode, ...(stage.stdout ? { stdout: String(stage.stdout).slice(-40_000) } : {}), ...(stage.stderr ? { stderr: String(stage.stderr).slice(-20_000) } : {}) })); } catch { /* bounded diagnostic below */ }
    if (exitCode !== 0) { const last = evidence.at(-1); await rm(workspace, { recursive: true, force: true }); throw new Error(`WORKER_COMMAND_FAILED:${last ? `${last.name}:${String(last.stderr ?? last.stdout ?? "").slice(-2_000)}` : String(stderr).slice(-2_000) || String(stdout).slice(-2_000)}`); }
    if (evidence.length === 0) { await rm(workspace, { recursive: true, force: true }); throw new Error("WORKER_EVIDENCE_MISSING"); }
    return Object.freeze({ distRoot: join(output, "dist"), toolchainSha256: imageId!.slice("sha256:".length), commandEvidence: evidence, cleanup: async () => { await rm(workspace, { recursive: true, force: true }); } });
  }
}
