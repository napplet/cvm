import { sourceCapabilities } from "../../infra/dev-ui/source-capabilities";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { SourceProposalSchema } from "../model/model-gateway";
import { canonicalJson } from "../promotion/schema";
import type { StoredSourceProposal } from "./source-proposal-store";
import { parseWorkerDiagnostic, type WorkerDiagnostic } from "./worker-diagnostic";

const image = process.env.NAPPLET_CVM_DEV_WORKER_IMAGE ?? "napplet-cvm/dev-worker:development";
const Stage = z.object({ name: z.enum(["create", "init", "skills", "install", "build", "verify", "conformance", "dry-run"]), exitCode: z.number().int(), stdout: z.string().max(40_000).optional(), stderr: z.string().max(20_000).optional() }).strict();
const Report = z.object({ stages: z.array(Stage).min(1).max(8) }).strict();
export type WorkerOutput = Readonly<{ distRoot: string; toolchainSha256: string; commandEvidence: readonly z.infer<typeof Stage>[]; cleanup(): Promise<void> }>;

export async function runBoundedDevelopmentCommand(argv: string[], input: Readonly<{ deadlineMs: number; maxBytes: number; signal?: AbortSignal; onStdoutLine?: (line: string) => void }>) {
  input.signal?.throwIfAborted();
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  let total = 0;
  async function read(stream: ReadableStream<Uint8Array>, observe = false): Promise<string> {
    const reader = stream.getReader(); const chunks: Uint8Array[] = [];
    const decoder = new TextDecoder(); let line = "";
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        total += next.value.byteLength;
        if (total > input.maxBytes) throw new Error("WORKER_OUTPUT_LIMIT_EXCEEDED");
        chunks.push(next.value);
        if (observe && input.onStdoutLine) {
          line += decoder.decode(next.value, { stream: true });
          let end: number;
          while ((end = line.indexOf("\n")) >= 0) {
            const complete = line.slice(0, end); line = line.slice(end + 1);
            if (complete.length <= 1024) { try { input.onStdoutLine(complete); } catch { /* Non-authoritative observer. */ } }
          }
          // Keep memory bounded even for an output stream without newlines.
          if (line.length > input.maxBytes) throw new Error("WORKER_OUTPUT_LIMIT_EXCEEDED");
        }
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally { reader.releaseLock(); }
  }
  let abort!: () => void; let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("WORKER_ABORTED"));
    input.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => reject(new Error("WORKER_DEADLINE_EXCEEDED")), input.deadlineMs);
    if (input.signal?.aborted) abort();
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.race([Promise.all([child.exited, read(child.stdout, true), read(child.stderr)]), stopped]);
    return { exitCode, stdout, stderr };
  } catch (error) { child.kill("SIGKILL"); throw error; }
  finally { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); }
}

async function report(path: string): Promise<z.infer<typeof Report>> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > 512_000 || stat.nlink !== 1) throw new Error("WORKER_EVIDENCE_INVALID");
    return Report.parse(JSON.parse(await handle.readFile("utf8")));
  } finally { await handle.close(); }
}

/** Model-free closed-command worker, with independently bounded host and container lifetimes. */
export class LocalNappletWorker {
  constructor(private readonly input: Readonly<{ dockerBin?: string; image?: string; deadlineMs?: number; maxOutputBytes?: number; onProgress?: (stage: z.infer<typeof Stage>["name"] | "worker", state: "running" | "completed" | "failed", diagnostic?: WorkerDiagnostic) => void }> = {}) {
    for (const value of [input.deadlineMs, input.maxOutputBytes]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error("WORKER_LIMIT_INVALID");
    }
  }
  private progress(stage: z.infer<typeof Stage>["name"] | "worker", state: "running" | "completed" | "failed", diagnostic?: WorkerDiagnostic): void {
    try { this.input.onProgress?.(stage, state, diagnostic); } catch { /* Progress cannot affect execution. */ }
  }
  async materialize(inputProposal: Pick<StoredSourceProposal, "proposalSha256" | "proposal">, signal?: AbortSignal): Promise<WorkerOutput> {
    const proposal = SourceProposalSchema.parse(inputProposal.proposal);
    const sha256 = new Bun.CryptoHasher("sha256").update(canonicalJson({ files: proposal.files })).digest("hex");
    if (sha256 !== inputProposal.proposalSha256 || sha256 !== proposal.sha256 || proposal.reference !== `proposal:sha256:${sha256}` || proposal.files.some((file) => !["src/main.ts", "src/styles.css", "src/capabilities.json"].includes(file.path)) || Buffer.byteLength(JSON.stringify(proposal.files)) > 128_000) throw new Error("WORKER_SOURCE_PROPOSAL_INVALID");
    sourceCapabilities(proposal.files);
    signal?.throwIfAborted();
    this.progress("worker", "running");
    const docker = this.input.dockerBin ?? "docker";
    const inspected = await runBoundedDevelopmentCommand([docker, "image", "inspect", this.input.image ?? image, "--format", "{{.Id}}|{{.Os}}|{{.Architecture}}"], { deadlineMs: 15_000, maxBytes: 16_000, signal });
    const [imageId, os, arch] = inspected.stdout.trim().split("|");
    if (inspected.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/u.test(imageId ?? "") || os !== "linux" || arch !== (process.arch === "x64" ? "amd64" : "arm64")) throw new Error("WORKER_IMAGE_PRECONDITION_FAILED");
    const workspace = await mkdtemp(join(tmpdir(), "napplet-cvm-worker-")); const input = resolve(workspace, "input"); const output = resolve(workspace, "output");
    const containerName = `napplet-cvm-dev-worker-${crypto.randomUUID()}`; let retained = false;
    try {
      await mkdir(input); await mkdir(output); await chmod(output, 0o777);
      await writeFile(join(input, "proposal.json"), JSON.stringify({ proposalSha256: sha256, files: proposal.files }), { flag: "wx", mode: 0o444 });
      const args = ["run", "--name", containerName, "--label", "org.napplet-cvm.development-worker=true", "--rm", "--network", "none", "--read-only", "--user", "65532:65532", "--cpus", "2", "--memory", "2g", "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=256m", "--tmpfs", "/work:rw,exec,nosuid,nodev,size=512m", "--tmpfs", "/home/napplet:rw,exec,nosuid,nodev,size=128m", "-v", `${input}:/input:ro`, "-v", `${output}:/output:rw`, imageId!, "/usr/local/bin/run-proposal"];
      const result = await runBoundedDevelopmentCommand([docker, ...args], { deadlineMs: Math.max(1, Math.min(this.input.deadlineMs ?? 180_000, 180_000)), maxBytes: Math.max(1, Math.min(this.input.maxOutputBytes ?? 256_000, 256_000)), signal, onStdoutLine: (line) => {
        if (!line.startsWith("NAPPLET_STAGE ")) return;
        try {
          const event = z.object({ name: Stage.shape.name, state: z.enum(["running", "completed", "failed"]) }).strict().parse(JSON.parse(line.slice(14)));
          // Failed stages are emitted with their bounded diagnostic after the report is read.
          if (event.state !== "failed") this.progress(event.name, event.state);
        } catch { /* Untrusted runner output cannot expand the projection. */ }
      } });
      let evidence: z.infer<typeof Report>;
      try { evidence = await report(join(output, "report.json")); }
      catch { throw new Error(result.exitCode === 0 ? "WORKER_EVIDENCE_MISSING" : "WORKER_COMMAND_FAILED"); }
      if (result.exitCode !== 0) {
        const failed = evidence.stages.at(-1)!;
        this.progress(failed.name, "failed", failed.name === "verify" ? parseWorkerDiagnostic(failed.stdout ?? "") : undefined);
        throw new Error(`WORKER_COMMAND_FAILED:${failed.name}`, { cause: { stage: failed.name, exitCode: failed.exitCode, stdout: failed.stdout?.slice(-4_000), stderr: failed.stderr?.slice(-4_000) } });
      }
      retained = true;
      this.progress("worker", "completed");
      return Object.freeze({ distRoot: join(output, "dist"), toolchainSha256: imageId!.slice("sha256:".length), commandEvidence: evidence.stages, cleanup: async () => { await rm(workspace, { recursive: true, force: true }); } });
    } catch (error) {
      this.progress("worker", "failed"); throw error;
    } finally {
      // Killing the Docker CLI is insufficient: remove only this invocation's
      // exact container even when a build, stream, caller, or deadline fails.
      await runBoundedDevelopmentCommand([docker, "rm", "--force", containerName], { deadlineMs: 5_000, maxBytes: 8_000 }).catch(() => undefined);
      if (!retained) await rm(workspace, { recursive: true, force: true });
    }
  }
}
