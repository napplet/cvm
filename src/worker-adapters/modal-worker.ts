import { z } from "zod";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GrantRegistry, ScopedToolGateway } from "../capabilities/scoped-tool-gateway";
import { ToolRequestSchema } from "../phase-02/contracts";
import { canonicalJson } from "../promotion/schema";
import {
  CheckpointExportRequestSchema,
  CheckpointExportResultSchema,
  CheckpointFenceRequestSchema,
  CheckpointFenceResultSchema,
  CheckpointRestoreRequestSchema,
  CheckpointRestoreResultSchema,
  CheckpointTerminationRequestSchema,
  CheckpointTerminationResultSchema,
  WorkerRunRequestSchema,
  WorkerRunResultSchema,
  type ContinuationWorkerPort,
  type CheckpointExportRequest,
  type CheckpointExportResult,
  type CheckpointFenceRequest,
  type CheckpointFenceResult,
  type CheckpointRestoreRequest,
  type CheckpointRestoreResult,
  type CheckpointTerminationRequest,
  type CheckpointTerminationResult,
  type WorkerRunRequest,
  type WorkerRunResult,
} from "../phase-02/contracts";
import { PHASE_02_POLICY_INITIAL } from "../policy/phase-02-policy";

const SHA256_IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/i;
const FORBIDDEN_TAG = /secret|token|password|credential|private.?key|api.?key/i;
const MAX_OUTPUT_BYTES = PHASE_02_POLICY_INITIAL.sandbox.maxOutputBytes;
const CheckpointInventorySchema = z.array(z.string().min(1).max(PHASE_02_POLICY_INITIAL.tools.maxPathCharacters).refine(
  (path) => !path.startsWith("/") && !path.includes("\0") && !path.split("/").some((part) => part === "" || part === "." || part === ".."),
  "checkpoint inventory paths must be relative and contained",
)).min(1).max(1_000);

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

const ProbeCheckSchema = z.object({
  ownCanary: z.enum(["passed", "failed"]),
  siblingAbsent: z.enum(["passed", "failed"]),
  hostAbsent: z.enum(["passed", "failed"]),
  secretAbsent: z.enum(["passed", "failed"]),
  dnsDenied: z.enum(["passed", "failed"]),
  httpDenied: z.enum(["passed", "failed"]),
  websocketDenied: z.enum(["passed", "failed"]),
  tcpDenied: z.enum(["passed", "failed"]),
  noPorts: z.enum(["passed", "failed"]),
  gatewayAllowed: z.enum(["passed", "failed"]),
  runtimeBrowserBuild: z.enum(["passed", "failed"]),
  checkpointPortable: z.enum(["passed", "failed"]),
}).strict();
export type ModalProbeChecks = z.infer<typeof ProbeCheckSchema>;
export type ModalProbeEvidence = Readonly<{
  version: 1;
  provider: "modal";
  status: "passed" | "failed" | "blocked";
  selection: "eligible-not-selected" | "unselected";
  reasonCode: string;
  policyVersion: string;
  appName?: string;
  image?: string;
  regions?: readonly string[];
  checks?: ModalProbeChecks;
  failedChecks: readonly string[];
  limitations: readonly ["NOT_PRODUCTION_CERTIFIED", "SLO_NOT_MEASURED"];
  evidenceSha256: string;
}>;
export type ModalProbeObservation = Readonly<{ checks: ModalProbeChecks; termination: "observed" | "uncertain" }>;

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
const PROBE_EXEC = Object.freeze(["/usr/local/bin/napplet-cvm-probe", "observe-isolation"]);

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

function parseWorkerResult(stdout: string): WorkerRunResult {
  return WorkerRunResultSchema.parse(JSON.parse(stdout));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Candidate probe boundary: list output must exactly match a content-addressed checkpoint manifest. */
export async function validateProbeCheckpointInventory(listing: unknown, declared: unknown, manifestSha256: unknown): Promise<readonly string[]> {
  if (typeof manifestSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(manifestSha256)) throw new Error("checkpoint manifest digest is malformed");
  const actual = [...CheckpointInventorySchema.parse(listing)].sort();
  const expected = [...CheckpointInventorySchema.parse(declared)].sort();
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length || actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) throw new Error("checkpoint inventory does not match manifest");
  if (!actual.includes("checkpoint.tar.zst") || await sha256(canonicalJson(actual)) !== manifestSha256) throw new Error("checkpoint manifest is not bound to the observed inventory");
  return Object.freeze(actual);
}

async function sha256Bytes(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function buildEvidence(input: Omit<ModalProbeEvidence, "version" | "evidenceSha256">): Promise<ModalProbeEvidence> {
  const evidenceSha256 = await sha256(canonicalJson(input));
  return Object.freeze({ version: 1, ...input, evidenceSha256 });
}

export async function blockedModalProbeEvidence(reasonCode = "PROVIDER_UNSELECTED"): Promise<ModalProbeEvidence> {
  return buildEvidence({
    provider: "modal", status: "blocked", selection: "unselected", reasonCode,
    policyVersion: PHASE_02_POLICY_INITIAL.policyVersion, failedChecks: [],
    limitations: ["NOT_PRODUCTION_CERTIFIED", "SLO_NOT_MEASURED"],
  });
}

function failedEvidence(config: ModalWorkerConfig, checks: ModalProbeChecks | undefined, failedChecks: readonly string[], reasonCode: string): Promise<ModalProbeEvidence> {
  return buildEvidence({
    provider: "modal", status: "failed", selection: "unselected", reasonCode, policyVersion: config.policyVersion,
    appName: config.appName, image: config.image, ...(config.regions ? { regions: Object.freeze([...config.regions]) } : {}),
    ...(checks ? { checks } : {}), failedChecks: Object.freeze([...failedChecks]),
    limitations: ["NOT_PRODUCTION_CERTIFIED", "SLO_NOT_MEASURED"],
  });
}

async function observeLiveModalIsolation(config: ModalWorkerConfig): Promise<ModalProbeObservation> {
  const sdk = await productionModalSdk();
  const app = await sdk.apps.fromName(config.appName, { createIfMissing: false });
  const image = sdk.images.fromRegistry(config.image);
  const first = await sdk.sandboxes.create(app, image, strictCreateOptions(config));
  let second: ModalSandboxPort | undefined;
  let terminated = false;
  const tempDirectory = await mkdtemp("/tmp/napplet-cvm-modal-probe-");
  try {
    second = await sdk.sandboxes.create(app, image, strictCreateOptions(config));
    const gatewayResponse = join(tempDirectory, "gateway-response.json");
    await writeFile(gatewayResponse, '{"status":"coordinator-mediated"}\n', "utf8");
    await first.filesystem.copyFromLocal(gatewayResponse, `${config.workspaceRoot}/gateway-response.json`);
    const [firstProcess, secondProcess] = await Promise.all([
      first.exec(PROBE_EXEC, { timeoutMs: PHASE_02_POLICY_INITIAL.sandbox.execTimeoutSeconds * 1_000 }),
      second.exec(PROBE_EXEC, { timeoutMs: PHASE_02_POLICY_INITIAL.sandbox.execTimeoutSeconds * 1_000 }),
    ]);
    const [firstOutput, secondOutput] = await Promise.all([processOutput(firstProcess), processOutput(secondProcess)]);
    if (firstOutput.exitCode !== 0 || secondOutput.exitCode !== 0) throw new Error("probe command failed");
    const reportSchema = z.object({ checks: ProbeCheckSchema, gatewayRequest: ToolRequestSchema, checkpointSha256: z.string().regex(/^[a-f0-9]{64}$/i), checkpoint: z.object({ inventory: CheckpointInventorySchema, manifestSha256: z.string().regex(/^[a-f0-9]{64}$/i) }).strict() }).strict();
    const report = reportSchema.parse(JSON.parse(firstOutput.stdout));
    // Both fresh sandboxes must complete the same fixed probe before a report is considered.
    reportSchema.parse(JSON.parse(secondOutput.stdout));
    const grants = new GrantRegistry();
    grants.issue({
      id: "modal-probe-grant", sessionId: "modal-probe-session", actionId: "modal-probe-action", expectedVersion: 0,
      policyVersion: config.policyVersion, workspaceId: "modal-probe-workspace", workspaceRoot: config.workspaceRoot,
      tools: ["capture_evidence"], expiresAtMs: Date.now() + 60_000,
    });
    const gateway = new ScopedToolGateway(grants, { dispatch: async () => ({ output: { mediated: true } }) });
    const gatewayResult = await gateway.authorizeAndDispatch(report.gatewayRequest);
    if (gatewayResult.status !== "allowed") throw new Error("probe gateway request was not mediated");
    const checkpointPath = join(tempDirectory, "checkpoint.tar.zst");
    const listing = await first.filesystem.listFiles(config.workspaceRoot);
    await validateProbeCheckpointInventory(listing, report.checkpoint.inventory, report.checkpoint.manifestSha256);
    await first.filesystem.copyToLocal(`${config.workspaceRoot}/checkpoint.tar.zst`, checkpointPath);
    const actualCheckpointSha256 = await sha256Bytes(await Bun.file(checkpointPath).arrayBuffer());
    if (actualCheckpointSha256 !== report.checkpointSha256) throw new Error("checkpoint hash mismatch");
    return { checks: report.checks, termination: "observed" };
  } finally {
    const failures: unknown[] = [];
    for (const sandbox of [second, first]) {
      if (!sandbox) continue;
      try { await sandbox.terminate(); } catch (error) { failures.push(error); }
    }
    terminated = failures.length === 0;
    await rm(tempDirectory, { recursive: true, force: true });
    if (!terminated) throw new Error("probe termination is uncertain");
  }
}

/** Produces evidence only; a passed observation establishes candidate eligibility, never selection. */
export async function runModalIsolationProbe(input: Readonly<{
  config: unknown;
  observe?: (config: ModalWorkerConfig) => Promise<ModalProbeObservation>;
}>): Promise<ModalProbeEvidence> {
  const config = ModalWorkerConfigSchema.parse(input.config);
  try {
    const observation = await (input.observe ?? observeLiveModalIsolation)(config);
    const checks = ProbeCheckSchema.parse(observation.checks);
    const failedChecks = Object.entries(checks).filter(([, status]) => status !== "passed").map(([id]) => id);
    if (observation.termination !== "observed") failedChecks.push("termination");
    if (failedChecks.length > 0) return failedEvidence(config, checks, failedChecks, "PROBE_ASSERTION_FAILED");
    return buildEvidence({
      provider: "modal", status: "passed", selection: "eligible-not-selected", reasonCode: "PROBE_COMPLETE",
      policyVersion: config.policyVersion, appName: config.appName, image: config.image,
      ...(config.regions ? { regions: Object.freeze([...config.regions]) } : {}), checks, failedChecks: [],
      limitations: ["NOT_PRODUCTION_CERTIFIED", "SLO_NOT_MEASURED"],
    });
  } catch {
    return failedEvidence(config, undefined, ["probeExecution"], "PROBE_EXECUTION_FAILED");
  }
}

async function productionModalSdk(): Promise<ModalSdkPort> {
  const { ModalClient } = await import("modal");
  const client = new ModalClient();
  return {
    apps: { fromName: (name, options) => client.apps.fromName(name, options) },
    images: { fromRegistry: (image) => client.images.fromRegistry(image) },
    sandboxes: {
      async create(app, image, options) {
        const sandbox = await client.sandboxes.create(app as never, image as never, options as never);
        return sandboxPort(sandbox);
      },
    },
  };
}

function sandboxPort(sandbox: {
  sandboxId: string;
  exec(command: string[], options: { timeoutMs: number }): Promise<ModalProcessPort>;
  poll(): Promise<unknown>;
  terminate(): Promise<void>;
  filesystem: ModalSandboxPort["filesystem"];
}): ModalSandboxPort {
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
export class ModalWorkerAdapter implements ContinuationWorkerPort {
  readonly #config: ModalWorkerConfig;
  readonly #sdk: ModalSdkPort;

  constructor(config: unknown, sdk: ModalSdkPort) {
    this.#config = ModalWorkerConfigSchema.parse(config);
    this.#sdk = sdk;
  }

  async run(input: WorkerRunRequest, signal: AbortSignal): Promise<WorkerRunResult> {
    const request = WorkerRunRequestSchema.safeParse(input);
    if (!request.success) return WorkerRunResultSchema.parse({ status: "unavailable", code: "WORKER_UNAVAILABLE" });
    if (signal.aborted) return WorkerRunResultSchema.parse({ status: "interrupted", code: "WORKER_INTERRUPTED" });
    let sandbox: ModalSandboxPort | undefined;
    let requestDirectory: string | undefined;
    let result: WorkerRunResult = WorkerRunResultSchema.parse({ status: "unavailable", code: "WORKER_UNAVAILABLE" });
    let terminationUncertain = false;
    try {
      const app = await this.#sdk.apps.fromName(this.#config.appName, { createIfMissing: false });
      const image = this.#sdk.images.fromRegistry(this.#config.image);
      sandbox = await this.#sdk.sandboxes.create(app, image, strictCreateOptions(this.#config));
      requestDirectory = await mkdtemp("/tmp/napplet-cvm-modal-request-");
      const localRequestPath = join(requestDirectory, "request.json");
      const remoteRequestPath = `${this.#config.workspaceRoot}/.napplet-cvm/request.json`;
      await writeFile(localRequestPath, canonicalJson(request.data), "utf8");
      await sandbox.filesystem.copyFromLocal(localRequestPath, remoteRequestPath);
      const process = await sandbox.exec([...WORKER_EXEC, "--request", remoteRequestPath], { timeoutMs: PHASE_02_POLICY_INITIAL.sandbox.execTimeoutSeconds * 1_000 });
      const output = await processOutput(process);
      if (output.exitCode !== 0 || signal.aborted) throw new Error("worker did not complete cleanly");
      result = parseWorkerResult(output.stdout);
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
      if (requestDirectory) {
        try {
          await rm(requestDirectory, { recursive: true, force: true });
        } catch {
          terminationUncertain = true;
        }
      }
    }
    return terminationUncertain ? WorkerRunResultSchema.parse({ status: "unavailable", code: "WORKER_UNAVAILABLE" }) : result;
  }

  async exportCheckpoint(input: CheckpointExportRequest): Promise<CheckpointExportResult> {
    CheckpointExportRequestSchema.safeParse(input);
    return CheckpointExportResultSchema.parse({ status: "denied", code: "WORKER_CONTINUATION_DENIED" });
  }

  async fenceCheckpoint(input: CheckpointFenceRequest): Promise<CheckpointFenceResult> {
    CheckpointFenceRequestSchema.safeParse(input);
    return CheckpointFenceResultSchema.parse({ status: "denied", code: "WORKER_CONTINUATION_DENIED" });
  }

  async restoreCheckpoint(input: CheckpointRestoreRequest): Promise<CheckpointRestoreResult> {
    CheckpointRestoreRequestSchema.safeParse(input);
    return CheckpointRestoreResultSchema.parse({ status: "denied", code: "WORKER_CONTINUATION_DENIED" });
  }

  async terminateCheckpoint(input: CheckpointTerminationRequest): Promise<CheckpointTerminationResult> {
    CheckpointTerminationRequestSchema.safeParse(input);
    return CheckpointTerminationResultSchema.parse({ status: "denied", code: "WORKER_CONTINUATION_DENIED" });
  }
}

export async function createModalWorkerAdapter(config: unknown): Promise<ModalWorkerAdapter> {
  const parsed = ModalWorkerConfigSchema.parse(config);
  return new ModalWorkerAdapter(parsed, await productionModalSdk());
}
