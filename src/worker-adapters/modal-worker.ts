import { ModalClient, type App, type Image, type Sandbox, type SandboxCreateParams } from "modal";
import { z } from "zod";
import {
  WorkerEventSchema,
  WorkerRunRequestSchema,
  WorkerRunResultSchema,
  type WorkerEvent,
  type WorkerPort,
  type WorkerRunRequest,
  type WorkerRunResult,
} from "../phase-02/contracts";
import { PHASE_02_POLICY_INITIAL } from "../policy/phase-02-policy";

const SHA256_IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/i;
const FORBIDDEN_TAG = /secret|token|password|credential|private.?key|api.?key/i;
const MAX_OUTPUT_BYTES = PHASE_02_POLICY_INITIAL.sandbox.maxOutputBytes;

const tagsSchema = z.record(z.string().min(1).max(64), z.string().min(1).max(256)).superRefine((tags, ctx) => {
  for (const [key, value] of Object.entries(tags)) {
    if (FORBIDDEN_TAG.test(key) || FORBIDDEN_TAG.test(value)) ctx.addIssue({ code: "custom", message: "correlation tags must not carry authority" });
  }
});

/** The small, project-owned observation selector is intentionally not an SDK params mirror. */
export const ModalWorkerConfigSchema = z.object({
  appName: z.string().min(1).max(128),
  image: z.string().regex(SHA256_IMAGE, "image must be a registry digest reference"),
  regions: z.array(z.string().min(1).max(64)).min(1).max(8).optional(),
  workspaceRoot: z.string().regex(/^\/(?:[^/\0]+\/?)*$/u, "workspaceRoot must be absolute and contained"),
  policyVersion: z.literal(PHASE_02_POLICY_INITIAL.policyVersion),
  tags: tagsSchema,
}).strict();
export type ModalWorkerConfig = z.infer<typeof ModalWorkerConfigSchema>;

export type ModalSandboxCreateOptions = Readonly<{
  cpu: number;
  cpuLimit: number;
  memoryMiB: number;
  memoryLimitMiB: number;
  timeoutMs: number;
  idleTimeoutMs: number;
  workdir: string;
  command: readonly string[];
  env: Readonly<Record<string, string>>;
  blockNetwork: true;
  tags: Readonly<Record<string, string>>;
  regions?: readonly string[];
}>;
export type ModalProcessPort = Readonly<{
  stdout?: unknown;
  stderr?: unknown;
  exitCode?: unknown;
  wait?: () => Promise<number>;
}>;
export interface ModalSandboxPort {
  readonly id: string;
  exec(argv: readonly string[], options: Readonly<{ timeoutMs: number }>): Promise<ModalProcessPort>;
  poll(): Promise<unknown>;
  terminate(): Promise<void>;
  readonly filesystem: {
    copyFromLocal(localPath: string, remotePath: string): Promise<void>;
    copyToLocal(remotePath: string, localPath: string): Promise<void>;
    listFiles(remotePath: string): Promise<unknown>;
  };
}
/** Test seam: only the deliberate COVERAGE.md surface crosses this adapter boundary. */
export interface ModalSdkPort {
  readonly apps: { fromName(name: string, options: Readonly<{ createIfMissing: false }>): Promise<unknown> };
  readonly images: { fromRegistry(image: string): unknown };
  readonly sandboxes: { create(app: unknown, image: unknown, options: ModalSandboxCreateOptions): Promise<ModalSandboxPort> };
}

const FIXED_ENTRYPOINT = Object.freeze(["/bin/sh", "-c", "while true; do sleep 60; done"]);
const WORKER_EXEC = Object.freeze(["/usr/local/bin/napplet-cvm-worker", "run-proposal"]);

function strictCreateOptions(config: ModalWorkerConfig): ModalSandboxCreateOptions {
  const sandbox = PHASE_02_POLICY_INITIAL.sandbox;
  const [cpu, cpuLimit] = sandbox.cpu.split("/").map(Number);
  const [memoryGiB, memoryLimitGiB] = sandbox.memoryGiB.split("/").map(Number);
  return Object.freeze({
    cpu,
    cpuLimit,
    memoryMiB: memoryGiB * 1024,
    memoryLimitMiB: memoryLimitGiB * 1024,
    timeoutMs: sandbox.lifetimeMinutes * 60_000,
    idleTimeoutMs: sandbox.idleTimeoutMinutes * 60_000,
    workdir: config.workspaceRoot,
    command: FIXED_ENTRYPOINT,
    env: Object.freeze({ NAPPLET_CVM_POLICY_VERSION: config.policyVersion }),
    blockNetwork: true,
    tags: Object.freeze({ ...config.tags }),
    ...(config.regions ? { regions: Object.freeze([...config.regions]) } : {}),
  });
}

async function streamToBoundedText(value: unknown, counter: { bytes: number }): Promise<string> {
  if (typeof value === "string") return appendBounded(value, counter);
  if (value === undefined || value === null) return "";
  if (typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    let output = "";
    for await (const part of value as AsyncIterable<unknown>) output += appendBounded(String(part), counter);
    return output;
  }
  throw new Error("provider stream is malformed");
}

function appendBounded(value: string, counter: { bytes: number }): string {
  counter.bytes += new TextEncoder().encode(value).byteLength;
  if (counter.bytes > MAX_OUTPUT_BYTES) throw new Error("provider output ceiling exceeded");
  return value;
}

async function processOutput(process: ModalProcessPort): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const counter = { bytes: 0 };
  const stdout = await streamToBoundedText(process.stdout, counter);
  const stderr = await streamToBoundedText(process.stderr, counter);
  const exitCode = typeof process.exitCode === "number" ? process.exitCode : process.wait ? await process.wait() : undefined;
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) throw new Error("provider exit code is malformed");
  return { stdout, stderr, exitCode };
}

function parseEvents(stdout: string): WorkerEvent[] {
  const lines = stdout.split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("worker emitted no events");
  return lines.map((line) => WorkerEventSchema.parse(JSON.parse(line)));
}

function productionModalSdk(): ModalSdkPort {
  const client = new ModalClient();
  return {
    apps: { fromName: (name, options) => client.apps.fromName(name, options) },
    images: { fromRegistry: (image) => client.images.fromRegistry(image) },
    sandboxes: {
      async create(app, image, options) {
        const sandbox = await client.sandboxes.create(app as App, image as Image, options as SandboxCreateParams);
        return sandboxPort(sandbox);
      },
    },
  };
}

function sandboxPort(sandbox: Sandbox): ModalSandboxPort {
  return {
    id: sandbox.sandboxId,
    exec: async (argv, options) => sandbox.exec([...argv], options),
    poll: () => sandbox.poll(),
    terminate: () => sandbox.terminate(),
    filesystem: {
      copyFromLocal: (localPath, remotePath) => sandbox.filesystem.copyFromLocal(localPath, remotePath),
      copyToLocal: (remotePath, localPath) => sandbox.filesystem.copyToLocal(remotePath, localPath),
      listFiles: (remotePath) => sandbox.filesystem.listFiles(remotePath),
    },
  };
}

/** Candidate-only adapter. It returns only project WorkerPort values, never Modal objects or errors. */
export class ModalWorkerAdapter implements WorkerPort {
  readonly #config: ModalWorkerConfig;
  readonly #sdk: ModalSdkPort;

  constructor(config: unknown, sdk: ModalSdkPort = productionModalSdk()) {
    this.#config = ModalWorkerConfigSchema.parse(config);
    this.#sdk = sdk;
  }

  async run(input: WorkerRunRequest, signal: AbortSignal): Promise<WorkerRunResult> {
    const request = WorkerRunRequestSchema.safeParse(input);
    if (!request.success) return WorkerRunResultSchema.parse({ status: "unavailable", code: "WORKER_UNAVAILABLE" });
    if (signal.aborted) return WorkerRunResultSchema.parse({ status: "interrupted", code: "WORKER_INTERRUPTED" });
    let sandbox: ModalSandboxPort | undefined;
    let result: WorkerRunResult = WorkerRunResultSchema.parse({ status: "unavailable", code: "WORKER_UNAVAILABLE" });
    let terminationUncertain = false;
    try {
      const app = await this.#sdk.apps.fromName(this.#config.appName, { createIfMissing: false });
      const image = this.#sdk.images.fromRegistry(this.#config.image);
      sandbox = await this.#sdk.sandboxes.create(app, image, strictCreateOptions(this.#config));
      const process = await sandbox.exec(WORKER_EXEC, { timeoutMs: PHASE_02_POLICY_INITIAL.sandbox.execTimeoutSeconds * 1_000 });
      const output = await processOutput(process);
      if (output.exitCode !== 0 || signal.aborted) throw new Error("worker did not complete cleanly");
      const events = parseEvents(output.stdout);
      result = WorkerRunResultSchema.parse({ status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events });
    } catch {
      result = WorkerRunResultSchema.parse({ status: "unavailable", code: "WORKER_UNAVAILABLE" });
    } finally {
      if (sandbox) {
        try {
          await sandbox.terminate();
        } catch {
          terminationUncertain = true;
        }
      }
    }
    return terminationUncertain ? WorkerRunResultSchema.parse({ status: "unavailable", code: "WORKER_UNAVAILABLE" }) : result;
  }
}

export function createModalWorkerAdapter(config: unknown): ModalWorkerAdapter {
  return new ModalWorkerAdapter(config, productionModalSdk());
}
