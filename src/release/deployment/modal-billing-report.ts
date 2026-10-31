import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../../promotion/schema";

/** Public distribution identity for the dedicated report collector, never a
 * generated-code worker. Its installed environment must additionally pin and
 * verify the executable and transitive dependency closure without account use. */
export const MODAL_1_6_3_VERSION = "1.6.3";
export const MODAL_1_6_3_SDIST_SHA256 = "f6c1c59172274357e260a6f3d24254dddb472a6d4202cabce87452c127a1779c";
export const MODAL_1_6_3_WHEEL_SHA256 = "31e8952c8908740f3fbc666191fec78ff5fadecb7a48a29d40aed90b39531ffe";

const Digest = z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase());
const Identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u);
const Environment = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u);
const Timestamp = z.string().datetime({ offset: true });
const Cost = z.string().regex(/^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,6})?$/u);
const TagValue = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/=-]*$/u);
const RequiredTags = z.record(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/u), TagValue).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 8);

const GrantInputSchema = z.object({
  version: z.literal(1), authorizationRequestSha256: Digest, authorizationReceiptSha256: Digest, candidateSha256: Digest,
  operationRecordSha256: Digest, accountScopeSha256: Digest, environmentScopeSha256: Digest, resourceIdentitySha256: Digest,
  currencyPolicySha256: Digest, credentialReferenceSha256: Digest, cliExecutableSha256: Digest,
  environmentName: Environment, expectedObjectId: Identifier, intervalStartMs: z.number().int().positive(), intervalEndMs: z.number().int().positive(),
  requiredTags: RequiredTags, maximumStdoutBytes: z.number().int().min(1).max(1_048_576), maximumStderrBytes: z.number().int().min(1).max(262_144),
  timeoutMs: z.number().int().min(1).max(30_000), maximumAttempts: z.number().int().min(1).max(8), expiresAtMs: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (value.intervalEndMs <= value.intervalStartMs || value.intervalStartMs % 3_600_000 !== 0 || value.intervalEndMs % 3_600_000 !== 0) context.addIssue({ code: "custom", message: "MODAL_BILLING_GRANT_INTERVAL_INVALID" });
});
const GrantSchema = GrantInputSchema.extend({ grantSha256: Digest }).strict();
export type ModalBillingObservationGrant = Readonly<z.infer<typeof GrantSchema>>;

const ReportRowSchema = z.object({
  object_id: Identifier, description: z.string().min(1).max(1_024), environment: Environment, interval_start: Timestamp,
  resource: z.string().min(1).max(256), cost: Cost, tags: z.string().min(2).max(8_192),
}).strict();
export type ModalBillingReportRow = Readonly<z.infer<typeof ReportRowSchema>>;

export type ModalBillingArtifactReference = Readonly<{ uri: string; generation: string; sha256: string }>;
export type ModalBillingArtifactStore = Readonly<{
  createImmutable(input: Readonly<{ key: string; bytes: Uint8Array; sha256: string }>): Promise<ModalBillingArtifactReference>;
  readExact(reference: ModalBillingArtifactReference): Promise<Uint8Array | undefined>;
}>;
export type ModalBillingCredentialResolver = Readonly<{
  /** Implementations resolve only a preapproved secret reference at dispatch.
   * The collector never accepts credentials in grants, config, logs, or argv. */
  resolve(reference: string): Promise<Readonly<{ tokenId: string; tokenSecret: string }>>;
}>;

type ReportDisposition = "passed" | "non_zero_exit" | "timeout" | "output_overflow";
export type ModalBillingChildResult = Readonly<{
  disposition: ReportDisposition; exitCode: number | null; terminationSignal?: "SIGTERM" | "SIGKILL"; argv: readonly string[]; stdout: Uint8Array; stderr: Uint8Array;
  startedAtMs: number; finishedAtMs: number; interpreterSha256?: string;
}>;

const sha256 = (value: string | Uint8Array | ArrayBuffer) => createHash("sha256").update(value instanceof ArrayBuffer ? new Uint8Array(value) : value).digest("hex");
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function reportRequestSha256(grant: z.infer<typeof GrantInputSchema>): string {
  return sha256(canonicalJson({
    version: grant.version, authorizationRequestSha256: grant.authorizationRequestSha256, authorizationReceiptSha256: grant.authorizationReceiptSha256,
    candidateSha256: grant.candidateSha256, operationRecordSha256: grant.operationRecordSha256, accountScopeSha256: grant.accountScopeSha256,
    environmentScopeSha256: grant.environmentScopeSha256, resourceIdentitySha256: grant.resourceIdentitySha256, currencyPolicySha256: grant.currencyPolicySha256,
    credentialReferenceSha256: grant.credentialReferenceSha256, cliExecutableSha256: grant.cliExecutableSha256, environmentName: grant.environmentName,
    expectedObjectId: grant.expectedObjectId, intervalStartMs: grant.intervalStartMs, intervalEndMs: grant.intervalEndMs, requiredTags: grant.requiredTags,
    maximumStdoutBytes: grant.maximumStdoutBytes, maximumStderrBytes: grant.maximumStderrBytes, timeoutMs: grant.timeoutMs,
    maximumAttempts: grant.maximumAttempts, expiresAtMs: grant.expiresAtMs,
  }));
}

export function createModalBillingObservationGrant(input: z.input<typeof GrantInputSchema>): ModalBillingObservationGrant {
  const grant = GrantInputSchema.parse(input);
  return Object.freeze({ ...grant, grantSha256: reportRequestSha256(grant) });
}

export function verifyModalBillingObservationGrant(input: unknown): ModalBillingObservationGrant {
  const grant = GrantSchema.parse(input);
  if (grant.grantSha256 !== reportRequestSha256(grant)) throw new Error("MODAL_BILLING_GRANT_DIGEST_INVALID");
  return Object.freeze(grant);
}

function duplicateKeyCheck(text: string): void {
  let offset = 0;
  const whitespace = () => { while (/\s/u.test(text[offset] ?? "")) offset++; };
  const string = (): string => {
    if (text[offset] !== "\"") throw new Error("MODAL_BILLING_REPORT_JSON_INVALID");
    const start = offset++;
    let escaped = false;
    while (offset < text.length) {
      const next = text[offset++]!;
      if (escaped) { escaped = false; continue; }
      if (next === "\\") { escaped = true; continue; }
      if (next === "\"") {
        try { return JSON.parse(text.slice(start, offset)); }
        catch { throw new Error("MODAL_BILLING_REPORT_JSON_INVALID"); }
      }
      if (next.charCodeAt(0) < 0x20) throw new Error("MODAL_BILLING_REPORT_JSON_INVALID");
    }
    throw new Error("MODAL_BILLING_REPORT_JSON_INVALID");
  };
  const value = (): void => {
    whitespace(); const next = text[offset];
    if (next === "{") { object(); return; }
    if (next === "[") { array(); return; }
    if (next === "\"") { string(); return; }
    const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(text.slice(offset));
    if (!literal) throw new Error("MODAL_BILLING_REPORT_JSON_INVALID");
    offset += literal[0].length;
  };
  const array = (): void => {
    offset++; whitespace(); if (text[offset] === "]") { offset++; return; }
    while (true) { value(); whitespace(); if (text[offset] === "]") { offset++; return; } if (text[offset++] !== ",") throw new Error("MODAL_BILLING_REPORT_JSON_INVALID"); whitespace(); }
  };
  const object = (): void => {
    offset++; whitespace(); const keys = new Set<string>(); if (text[offset] === "}") { offset++; return; }
    while (true) {
      const key = string(); if (keys.has(key)) throw new Error("MODAL_BILLING_REPORT_DUPLICATE_KEY"); keys.add(key);
      whitespace(); if (text[offset++] !== ":") throw new Error("MODAL_BILLING_REPORT_JSON_INVALID"); value(); whitespace();
      if (text[offset] === "}") { offset++; return; } if (text[offset++] !== ",") throw new Error("MODAL_BILLING_REPORT_JSON_INVALID"); whitespace();
    }
  };
  value(); whitespace(); if (offset !== text.length) throw new Error("MODAL_BILLING_REPORT_JSON_INVALID");
}

function decode(bytesValue: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytesValue); }
  catch { throw new Error("MODAL_BILLING_REPORT_UTF8_INVALID"); }
}

function tagTable(value: string): Readonly<Record<string, string>> {
  duplicateKeyCheck(value);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("MODAL_BILLING_REPORT_TAGS_INVALID"); }
  return RequiredTags.parse(parsed);
}

export function parseModalBillingReport(raw: Uint8Array): readonly ModalBillingReportRow[] {
  const text = decode(raw); duplicateKeyCheck(text);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("MODAL_BILLING_REPORT_JSON_INVALID"); }
  let rows: z.infer<typeof ReportRowSchema>[];
  try { rows = z.array(ReportRowSchema).min(1).max(10_000).parse(parsed); }
  catch { throw new Error("MODAL_BILLING_REPORT_SCHEMA_INVALID"); }
  try { for (const row of rows) tagTable(row.tags); }
  catch { throw new Error("MODAL_BILLING_REPORT_SCHEMA_INVALID"); }
  return Object.freeze(rows.map(row => Object.freeze({ ...row })));
}

function validRows(rows: readonly ModalBillingReportRow[], grant: ModalBillingObservationGrant): boolean {
  const tags = grant.requiredTags;
  let expectedHours = 0;
  for (let cursor = grant.intervalStartMs; cursor < grant.intervalEndMs; cursor += 3_600_000) expectedHours++;
  const intervals = new Set<number>();
  for (const row of rows) {
    const at = Date.parse(row.interval_start);
    if (!Number.isSafeInteger(at) || at < grant.intervalStartMs || at >= grant.intervalEndMs || at % 3_600_000 !== 0 || row.object_id !== grant.expectedObjectId || row.environment !== grant.environmentName) return false;
    const observed = tagTable(row.tags);
    if (!equal(observed, tags)) return false;
    intervals.add(at);
  }
  return intervals.size === expectedHours;
}

function nonnegativeMicros(rows: readonly ModalBillingReportRow[]): bigint {
  return rows.reduce((total, row) => {
    const [whole, fractional = ""] = row.cost.split(".");
    const micros = BigInt(whole!) * 1_000_000n + BigInt((fractional + "000000").slice(0, 6));
    return total + micros;
  }, 0n);
}

async function bounded(stream: ReadableStream<Uint8Array>, limit: number, stopped: Promise<void>, terminate: () => void): Promise<Readonly<{ bytes: Uint8Array; overflowed: boolean }>> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let length = 0; let overflowed = false;
  try {
    while (true) {
      const next = await Promise.race([
        reader.read().catch(() => ({ done: true, value: undefined })),
        stopped.then(() => ({ done: true, value: undefined })),
      ]);
      if (next.done || !next.value) break;
      const remaining = limit - length;
      if (next.value.byteLength > remaining) { if (remaining > 0) chunks.push(next.value.slice(0, remaining)); length = limit; overflowed = true; terminate(); await reader.cancel().catch(() => undefined); break; }
      chunks.push(next.value); length += next.value.byteLength;
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let index = 0;
  for (const chunk of chunks) { result.set(chunk, index); index += chunk.byteLength; }
  return Object.freeze({ bytes: result, overflowed });
}

/** The optional control image's pip-generated entrypoint has this exact
 * shebang. The interpreter and its closure are bound by the candidate image;
 * neither PATH nor a caller-selected interpreter can redirect this launch. */
export const MODAL_BILLING_PYTHON = "/opt/napplet-cvm-modal/venv/bin/python";

async function assertImmutableRootPath(path: string): Promise<void> {
  for (let current = path;; current = dirname(current)) {
    const metadata = await lstat(current);
    if (metadata.uid !== 0 || (!metadata.isSymbolicLink() && (metadata.mode & 0o022) !== 0)) throw new Error("MODAL_BILLING_INTERPRETER_MUTABLE");
    if (current === "/") return;
  }
}

/** Input bytes must already match the controller-approved executable hash and
 * have been written to the caller's private copy. Read a canonical Python
 * script as data through the immutable image interpreter: no exec permission
 * on the disposable filesystem is needed. Other verified executable formats
 * retain their original direct-exec behavior. No report/credential authority
 * is created by constructing this argv prefix. */
export async function pinnedModalBillingLaunch(input: Readonly<{ verifiedBytes: Uint8Array; privateExecutable: string }>): Promise<Readonly<{ argvPrefix: readonly string[]; interpreterSha256?: string }>> {
  if (!input.privateExecutable.startsWith("/")) throw new Error("MODAL_BILLING_PRIVATE_EXECUTABLE_INVALID");
  const shebang = new TextDecoder().decode(input.verifiedBytes.subarray(0, MODAL_BILLING_PYTHON.length + 3));
  if (shebang !== `#!${MODAL_BILLING_PYTHON}\n`) return Object.freeze({ argvPrefix: Object.freeze([input.privateExecutable]) });
  await assertImmutableRootPath(MODAL_BILLING_PYTHON);
  const resolved = await realpath(MODAL_BILLING_PYTHON);
  if (resolved !== "/usr/local/bin/python3.14") throw new Error("MODAL_BILLING_INTERPRETER_IDENTITY_INVALID");
  await assertImmutableRootPath(resolved);
  const interpreterSha256 = sha256(await Bun.file(resolved).arrayBuffer());
  return Object.freeze({ argvPrefix: Object.freeze([MODAL_BILLING_PYTHON, "-I", input.privateExecutable]), interpreterSha256 });
}

type ModalBillingCredential = Readonly<{ tokenId: string; tokenSecret: string }>;
type ModalBillingReportCommand = Readonly<{
  executable: string; executableSha256: string; environmentName: string; intervalStartMs: number; intervalEndMs: number; tagNames: readonly string[];
  maximumStdoutBytes: number; maximumStderrBytes: number; timeoutMs: number;
}>;
export type PreparedModalBillingReport = Readonly<{
  run(credential: ModalBillingCredential): Promise<ModalBillingChildResult>;
  close(): Promise<void>;
}>;

/** Validate and retain one private launch before any credential is resolved.
 * A resolver cannot replace the approved bytes, and a closed/consumed launch
 * cannot spawn another process. Every caller must close the disposable copy. */
export async function preparePinnedModalBillingReport(input: ModalBillingReportCommand): Promise<PreparedModalBillingReport> {
  if (!input.executable.startsWith("/") || !Digest.safeParse(input.executableSha256).success || !Environment.safeParse(input.environmentName).success || input.intervalEndMs <= input.intervalStartMs || input.intervalStartMs % 3_600_000 !== 0 || input.intervalEndMs % 3_600_000 !== 0 || input.tagNames.length < 1 || input.tagNames.length > 8 || !input.tagNames.every(name => /^[a-z][a-z0-9_]{1,63}$/u.test(name)) || [...input.tagNames].sort().join(",") !== [...input.tagNames].join(",") || !Number.isSafeInteger(input.maximumStdoutBytes) || input.maximumStdoutBytes < 1 || !Number.isSafeInteger(input.maximumStderrBytes) || input.maximumStderrBytes < 1 || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30_000) throw new Error("MODAL_BILLING_CHILD_INPUT_INVALID");
  const executableBytes = new Uint8Array(await Bun.file(input.executable).arrayBuffer());
  if (sha256(executableBytes) !== input.executableSha256.toLowerCase()) throw new Error("MODAL_BILLING_EXECUTABLE_DIGEST_INVALID");
  const home = await mkdtemp(join(tmpdir(), "napplet-cvm-modal-billing-"));
  const verifiedExecutable = join(home, "modal-verified");
  const argv = Object.freeze([input.executable, "environment", "billing", "report", input.environmentName, "--start", new Date(input.intervalStartMs).toISOString(), "--end", new Date(input.intervalEndMs).toISOString(), "--resolution", "h", "--tag-names", input.tagNames.join(","), "--show-resources", "--json"]);
  try {
    /* Run a private copy of the bytes that were hashed.  The configured path
     * is never executed after verification, so a replacement race cannot gain
     * either of the dispatch credentials. */
    await writeFile(verifiedExecutable, executableBytes, { mode: 0o700 });
    await chmod(verifiedExecutable, 0o700);
    const launch = await pinnedModalBillingLaunch({ verifiedBytes: executableBytes, privateExecutable: verifiedExecutable });
    let closed = false, consumed = false;
    return Object.freeze({
      async run(credential: ModalBillingCredential): Promise<ModalBillingChildResult> {
        if (closed || consumed || !credential.tokenId || !credential.tokenSecret) throw new Error("MODAL_BILLING_PREPARED_LAUNCH_INVALID");
        consumed = true;
        const startedAtMs = Date.now();
        const child = Bun.spawn([...launch.argvPrefix, ...argv.slice(1)], { cwd: home, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true, env: {
          PATH: dirname(verifiedExecutable), HOME: home, MODAL_CONFIG_PATH: join(home, "modal.toml"), MODAL_LOGLEVEL: "WARNING", MODAL_TOKEN_ID: credential.tokenId, MODAL_TOKEN_SECRET: credential.tokenSecret,
        } });
        let timedOut = false, signal: "SIGTERM" | "SIGKILL" | undefined, stop!: () => void;
        const stopped = new Promise<void>(resolve => { stop = resolve; });
        let stopping: Promise<void> | undefined;
        const terminate = () => {
          if (stopping) return;
          stopping = (async () => {
            signal = "SIGTERM";
            try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
            await Promise.race([child.exited.then(() => undefined), Bun.sleep(50)]);
            signal = "SIGKILL";
            try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
            await Promise.race([child.exited.then(() => undefined), Bun.sleep(250)]);
            stop();
          })();
        };
        const timer = setTimeout(() => { timedOut = true; terminate(); }, input.timeoutMs);
        const exit = Promise.race([child.exited, stopped.then(() => null)]);
        const [exitCode, stdout, stderr] = await Promise.all([exit, bounded(child.stdout, input.maximumStdoutBytes, stopped, terminate), bounded(child.stderr, input.maximumStderrBytes, stopped, terminate)]).finally(() => clearTimeout(timer));
        if (stopping) await stopping;
        return Object.freeze({ disposition: timedOut ? "timeout" : stdout.overflowed || stderr.overflowed ? "output_overflow" : exitCode === 0 ? "passed" : "non_zero_exit", exitCode, ...(signal ? { terminationSignal: signal } : {}), argv, stdout: stdout.bytes, stderr: stderr.bytes, startedAtMs, finishedAtMs: Date.now(), ...(launch.interpreterSha256 ? { interpreterSha256: launch.interpreterSha256 } : {}) });
      },
      async close() { closed = true; await rm(home, { recursive: true, force: true }); },
    });
  } catch (error) { await rm(home, { recursive: true, force: true }); throw error; }
}

/** Executes exactly the published report command with one prepared launch. */
export async function runPinnedModalBillingReport(input: ModalBillingReportCommand & Readonly<{ credential: ModalBillingCredential }>): Promise<ModalBillingChildResult> {
  const prepared = await preparePinnedModalBillingReport(input);
  try { return await prepared.run(input.credential); }
  finally { await prepared.close(); }
}

type HeldReason = "attempt_limit" | "credential_unavailable" | "credential_echo" | "child_failure" | "report_invalid" | "scope_mismatch" | "finality_unproven" | "artifact_unavailable" | "grant_expired" | "dispatch_uncertain";
/** stderr may contain credentials or configuration supplied to the CLI. It is
 * never persisted as a raw artifact: only its bounded byte count and digest
 * are retained for correlation, neither of which can reconstruct its bytes. */
const ArtifactReferenceSchema = z.object({ uri: z.string().min(1).max(4_096), generation: z.string().min(1).max(256), sha256: Digest }).strict();
const HeldReasonSchema = z.enum(["attempt_limit", "credential_unavailable", "credential_echo", "child_failure", "report_invalid", "scope_mismatch", "finality_unproven", "artifact_unavailable", "grant_expired", "dispatch_uncertain"]);
const AttemptSchema = z.object({
  attempt: z.number().int().min(1).max(8), state: z.enum(["dispatch_intent", "completed"]), atMs: z.number().int().positive(),
  startedAtMs: z.number().int().positive().optional(), finishedAtMs: z.number().int().positive().optional(),
  disposition: z.enum(["passed", "non_zero_exit", "timeout", "output_overflow", "credential_unavailable", "credential_echo", "artifact_unavailable", "grant_expired", "launch_unavailable", "dispatch_unknown"]).optional(),
  argvSha256: Digest, executableSha256: Digest, interpreterSha256: Digest.optional(), stdout: ArtifactReferenceSchema.optional(), stdoutSha256: Digest.optional(), stderrByteLength: z.number().int().nonnegative().optional(), stderrSha256: Digest.optional(), exitCode: z.number().int().nullable().optional(), terminationSignal: z.enum(["SIGTERM", "SIGKILL"]).optional(), envelopeSha256: Digest.optional(), rowIdentitiesSha256: Digest.optional(), coverage: z.literal("unknown").optional(), reason: HeldReasonSchema.optional(),
}).strict();
export const ModalBillingReportCaptureSchema = z.object({ status: z.literal("held"), reason: HeldReasonSchema, grantSha256: Digest, reportRequestSha256: Digest, observedMicros: z.string().regex(/^[0-9]+$/u).optional() }).strict();
export const ModalBillingReportJournalRecordSchema = z.object({ schemaVersion: z.literal("modal-billing-report-journal-v2"), grantSha256: Digest, reportRequestSha256: Digest, attempts: z.array(AttemptSchema).max(8), result: ModalBillingReportCaptureSchema.optional() }).strict().superRefine((value, context) => {
  if (value.attempts.some((attempt, index) => attempt.attempt !== index + 1)) context.addIssue({ code: "custom", message: "MODAL_BILLING_JOURNAL_ATTEMPTS_INVALID" });
  if (value.attempts.some((attempt, index) => attempt.state === "dispatch_intent" && index !== value.attempts.length - 1)) context.addIssue({ code: "custom", message: "MODAL_BILLING_JOURNAL_INTENT_INVALID" });
  for (const attempt of value.attempts) {
    if (attempt.state === "completed" && (attempt.disposition === undefined || attempt.reason === undefined || attempt.finishedAtMs === undefined)) context.addIssue({ code: "custom", message: "MODAL_BILLING_JOURNAL_AUDIT_INCOMPLETE" });
    if ((attempt.stdout === undefined) !== (attempt.stdoutSha256 === undefined)) context.addIssue({ code: "custom", message: "MODAL_BILLING_JOURNAL_ARTIFACT_INVALID" });
    if (["passed", "non_zero_exit", "timeout", "output_overflow"].includes(attempt.disposition ?? "") && (attempt.startedAtMs === undefined || attempt.exitCode === undefined)) context.addIssue({ code: "custom", message: "MODAL_BILLING_JOURNAL_CHILD_AUDIT_INCOMPLETE" });
  }
  if (value.result && value.result.grantSha256 !== value.grantSha256 || value.result && value.result.reportRequestSha256 !== value.reportRequestSha256) context.addIssue({ code: "custom", message: "MODAL_BILLING_JOURNAL_RESULT_INVALID" });
});
type Attempt = Readonly<z.infer<typeof AttemptSchema>>;
export type ModalBillingReportJournalRecord = Readonly<{ schemaVersion: "modal-billing-report-journal-v2"; grantSha256: string; reportRequestSha256: string; attempts: readonly Attempt[]; result?: ModalBillingReportCapture }>;
export type ModalBillingReportCapture = Readonly<z.infer<typeof ModalBillingReportCaptureSchema>>;
export type ModalBillingReportJournal = Readonly<{
  claim(input: ModalBillingReportJournalRecord): Promise<Readonly<{ claimed: boolean; revision: number; record: ModalBillingReportJournalRecord }>>;
  read(reportRequestSha256: string): Promise<Readonly<{ revision: number; record: ModalBillingReportJournalRecord }> | undefined>;
  compareAndSet(input: Readonly<{ reportRequestSha256: string; expectedRevision: number; record: ModalBillingReportJournalRecord }>): Promise<Readonly<{ revision: number; record: ModalBillingReportJournalRecord }> | undefined>;
}>;

/** Test-only in-memory journal; production binds the same CAS contract to the
 * operation journal in a mounted composition adapter. */
export function createMemoryModalBillingReportJournal(): ModalBillingReportJournal {
  const records = new Map<string, Readonly<{ revision: number; record: ModalBillingReportJournalRecord }>>();
  return Object.freeze({
    async claim(record) { const previous = records.get(record.reportRequestSha256); if (previous) { if (previous.record.grantSha256 !== record.grantSha256 || previous.record.schemaVersion !== record.schemaVersion) throw new Error("MODAL_BILLING_JOURNAL_CONFLICT"); return { claimed: false, ...previous }; } const saved = Object.freeze({ revision: 1, record: Object.freeze(record) }); records.set(record.reportRequestSha256, saved); return { claimed: true, ...saved }; },
    async read(request) { return records.get(request); },
    async compareAndSet(input) { const current = records.get(input.reportRequestSha256); if (!current || current.revision !== input.expectedRevision || current.record.grantSha256 !== input.record.grantSha256) return undefined; const saved = Object.freeze({ revision: current.revision + 1, record: Object.freeze(input.record) }); records.set(input.reportRequestSha256, saved); return saved; },
  });
}

function held(grant: ModalBillingObservationGrant, reason: HeldReason, observedMicros?: string): ModalBillingReportCapture {
  return Object.freeze({ status: "held", reason, grantSha256: grant.grantSha256, reportRequestSha256: reportRequestSha256(grant), ...(observedMicros === undefined ? {} : { observedMicros }) });
}

async function finish(journal: ModalBillingReportJournal, current: Readonly<{ revision: number; record: ModalBillingReportJournalRecord }>, attempt: Attempt, result: ModalBillingReportCapture): Promise<ModalBillingReportCapture> {
  const next = Object.freeze({ ...current.record, attempts: Object.freeze([...current.record.attempts.slice(0, -1), attempt]), result });
  const saved = await journal.compareAndSet({ reportRequestSha256: current.record.reportRequestSha256, expectedRevision: current.revision, record: next });
  if (saved) return saved.record.result ?? result;
  const reloaded = await journal.read(current.record.reportRequestSha256);
  if (reloaded?.record.result && equal(reloaded.record.result, result)) return result;
  throw new Error("MODAL_BILLING_JOURNAL_CONFLICT");
}

/** Provider reports are evidence only. A successful parse does not establish
 * eligibility, completeness, currency authority, coverage, finality, zero
 * spend, or a customer invoice, so this collector always returns `held`. */
export function createModalBillingReportCollector(input: Readonly<{
  executable: string; executableSha256: string; credentialReference: string; credentialReferenceSha256: string; credentialResolver: ModalBillingCredentialResolver;
  journal: ModalBillingReportJournal; artifacts: ModalBillingArtifactStore; artifactOrigin: string; now?: () => number;
}>) {
  if (!input.executable.startsWith("/") || !Digest.safeParse(input.executableSha256).success || !Digest.safeParse(input.credentialReferenceSha256).success || !/^secret\/[A-Za-z0-9][A-Za-z0-9_.:/-]{1,255}$/u.test(input.credentialReference) || !/^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._/-]{1,1024}$/iu.test(input.artifactOrigin) || !input.artifactOrigin.endsWith("/")) throw new Error("MODAL_BILLING_COLLECTOR_CONFIGURATION_INVALID");
  const now = input.now ?? Date.now;
  const verify = (raw: unknown) => {
    const grant = verifyModalBillingObservationGrant(raw);
    if (grant.cliExecutableSha256 !== input.executableSha256.toLowerCase() || grant.credentialReferenceSha256 !== input.credentialReferenceSha256.toLowerCase()) throw new Error("MODAL_BILLING_COLLECTOR_SCOPE_INVALID");
    return grant;
  };
  const active = (grant: ModalBillingObservationGrant) => now() < grant.expiresAtMs;
  const initial = (grant: ModalBillingObservationGrant): ModalBillingReportJournalRecord => Object.freeze({ schemaVersion: "modal-billing-report-journal-v2", grantSha256: grant.grantSha256, reportRequestSha256: reportRequestSha256(grant), attempts: Object.freeze([]) });
  const logicalArgv = (grant: ModalBillingObservationGrant) => Object.freeze([input.executable, "environment", "billing", "report", grant.environmentName, "--start", new Date(grant.intervalStartMs).toISOString(), "--end", new Date(grant.intervalEndMs).toISOString(), "--resolution", "h", "--tag-names", Object.keys(grant.requiredTags).sort().join(","), "--show-resources", "--json"]);
  const complete = (current: Readonly<{ revision: number; record: ModalBillingReportJournalRecord }>, grant: ModalBillingObservationGrant, patch: Omit<z.infer<typeof AttemptSchema>, "attempt" | "state" | "atMs" | "argvSha256" | "executableSha256">, result: ModalBillingReportCapture) => {
    const intent = current.record.attempts.at(-1);
    if (!intent || intent.state !== "dispatch_intent") throw new Error("MODAL_BILLING_JOURNAL_INTENT_REQUIRED");
    return finish(input.journal, current, Object.freeze({ ...intent, ...patch, state: "completed" as const, finishedAtMs: now() }), result);
  };
  const validArtifact = async (reference: ModalBillingArtifactReference, key: string, digest: string): Promise<Uint8Array | undefined> => {
    if (reference.sha256 !== digest || reference.uri !== `${input.artifactOrigin}${key}` || !/^[1-9][0-9]{0,255}$/u.test(reference.generation)) return undefined;
    const bytes = await input.artifacts.readExact(reference).catch(() => undefined);
    return bytes && sha256(bytes) === digest ? bytes : undefined;
  };
  const derive = (bytes: Uint8Array, grant: ModalBillingObservationGrant) => {
    try {
      const rows = parseModalBillingReport(bytes);
      const envelopeSha256 = sha256(canonicalJson(rows));
      const rowIdentitiesSha256 = sha256(canonicalJson(rows.map(row => ({ object_id: row.object_id, interval_start: row.interval_start, resource: row.resource }))));
      if (!validRows(rows, grant)) return { reason: "scope_mismatch" as const, envelopeSha256, rowIdentitiesSha256, coverage: "unknown" as const };
      return { reason: "finality_unproven" as const, observedMicros: nonnegativeMicros(rows).toString(), envelopeSha256, rowIdentitiesSha256, coverage: "unknown" as const };
    } catch { return { reason: "report_invalid" as const }; }
  };
  const recover = async (raw: unknown): Promise<ModalBillingReportCapture> => {
      const grant = verify(raw); const current = await input.journal.read(reportRequestSha256(grant));
      const parsed = ModalBillingReportJournalRecordSchema.safeParse(current?.record);
      if (!parsed.success || parsed.data.grantSha256 !== grant.grantSha256 || parsed.data.reportRequestSha256 !== reportRequestSha256(grant)) return held(grant, "artifact_unavailable");
      const record = parsed.data;
      const pending = record.attempts.at(-1);
      if (pending?.state === "dispatch_intent") return held(grant, "dispatch_uncertain");
      if (!record.result) return held(grant, "artifact_unavailable");
      const completed = record.attempts.at(-1);
      if (!completed || completed.state !== "completed" || completed.executableSha256 !== input.executableSha256.toLowerCase() || completed.argvSha256 !== sha256(canonicalJson(logicalArgv(grant)))) return held(grant, "artifact_unavailable");
      if (completed?.stdout) {
        if (!active(grant)) return held(grant, "grant_expired");
        const key = `modal-billing/${record.reportRequestSha256}/${completed.attempt}/stdout`;
        if (!completed.stdoutSha256) return held(grant, "artifact_unavailable");
        const bytes = await validArtifact(completed.stdout, key, completed.stdoutSha256);
        if (!bytes) return held(grant, "artifact_unavailable");
        if (!active(grant)) return held(grant, "grant_expired");
        if (completed.disposition === "non_zero_exit" || completed.disposition === "timeout" || completed.disposition === "output_overflow") {
          const failed = held(grant, "child_failure");
          return completed.reason === "child_failure" && completed.envelopeSha256 === undefined && completed.rowIdentitiesSha256 === undefined && completed.coverage === undefined && equal(record.result, failed) ? failed : held(grant, "artifact_unavailable");
        }
        const derived = derive(bytes, grant), recomputed = held(grant, derived.reason, derived.reason === "finality_unproven" ? derived.observedMicros : undefined);
        if (completed.disposition !== "passed" || completed.reason !== derived.reason || completed.coverage !== derived.coverage || completed.envelopeSha256 !== ("envelopeSha256" in derived ? derived.envelopeSha256 : undefined) || completed.rowIdentitiesSha256 !== ("rowIdentitiesSha256" in derived ? derived.rowIdentitiesSha256 : undefined) || !equal(record.result, recomputed)) return held(grant, "artifact_unavailable");
        return recomputed;
      }
      let reason: HeldReason | undefined;
      switch (completed.disposition) {
        case "credential_unavailable": reason = "credential_unavailable"; break;
        case "credential_echo": reason = "credential_echo"; break;
        case "grant_expired": reason = "grant_expired"; break;
        case "launch_unavailable":
        case "dispatch_unknown": reason = "child_failure"; break;
        case "artifact_unavailable": reason = "artifact_unavailable"; break;
      }
      if (reason && completed.reason === reason && completed.envelopeSha256 === undefined && completed.rowIdentitiesSha256 === undefined && completed.coverage === undefined) {
        const recomputed = held(grant, reason);
        if (equal(record.result, recomputed)) return recomputed;
      }
      return held(grant, "artifact_unavailable");
  };
  return Object.freeze({
    recover,
    async capture(raw: unknown): Promise<ModalBillingReportCapture> {
      const grant = verify(raw); const requested = initial(grant); const claimed = await input.journal.claim(requested);
      let current = { revision: claimed.revision, record: claimed.record };
      if (current.record.grantSha256 !== grant.grantSha256 || current.record.reportRequestSha256 !== requested.reportRequestSha256) throw new Error("MODAL_BILLING_JOURNAL_CONFLICT");
      if (current.record.result) return recover(grant);
      if (current.record.attempts.at(-1)?.state === "dispatch_intent") return held(grant, "dispatch_uncertain");
      if (current.record.attempts.length >= grant.maximumAttempts) return held(grant, "attempt_limit");
      const attempt = current.record.attempts.length + 1;
      const intent = Object.freeze({ attempt, state: "dispatch_intent" as const, atMs: now(), argvSha256: sha256(canonicalJson(logicalArgv(grant))), executableSha256: input.executableSha256.toLowerCase() });
      const intentRecord = Object.freeze({ ...current.record, attempts: Object.freeze([...current.record.attempts, intent]) });
      const intentSaved = await input.journal.compareAndSet({ reportRequestSha256: requested.reportRequestSha256, expectedRevision: current.revision, record: intentRecord });
      if (!intentSaved) {
        const reloaded = await input.journal.read(requested.reportRequestSha256);
        return reloaded?.record.result ? recover(grant) : held(grant, "dispatch_uncertain");
      }
      current = intentSaved;
      if (!active(grant)) return complete(current, grant, { disposition: "grant_expired", reason: "grant_expired" }, held(grant, "grant_expired"));
      let prepared: PreparedModalBillingReport;
      try { prepared = await preparePinnedModalBillingReport({ executable: input.executable, executableSha256: input.executableSha256, environmentName: grant.environmentName, intervalStartMs: grant.intervalStartMs, intervalEndMs: grant.intervalEndMs, tagNames: Object.keys(grant.requiredTags).sort(), maximumStdoutBytes: grant.maximumStdoutBytes, maximumStderrBytes: grant.maximumStderrBytes, timeoutMs: grant.timeoutMs }); }
      catch { return complete(current, grant, { disposition: "launch_unavailable", reason: "child_failure" }, held(grant, "child_failure")); }
      try {
        if (!active(grant)) return complete(current, grant, { disposition: "grant_expired", reason: "grant_expired" }, held(grant, "grant_expired"));
        let credential: ModalBillingCredential;
        try { credential = await input.credentialResolver.resolve(input.credentialReference); }
        catch { return complete(current, grant, { disposition: "credential_unavailable", reason: "credential_unavailable" }, held(grant, "credential_unavailable")); }
        if (!active(grant)) return complete(current, grant, { disposition: "grant_expired", reason: "grant_expired" }, held(grant, "grant_expired"));
        let child: ModalBillingChildResult;
        try { child = await prepared.run(credential); }
        catch { return complete(current, grant, { disposition: "dispatch_unknown", reason: "child_failure" }, held(grant, "child_failure")); }
        const interpreterAudit = child.interpreterSha256 ? { interpreterSha256: child.interpreterSha256 } : {};
        const stderrByteLength = child.stderr.byteLength;
        const stderrSha256 = sha256(child.stderr);
        const stdoutText = new TextDecoder().decode(child.stdout);
        const stderrText = new TextDecoder().decode(child.stderr);
        if (stdoutText.includes(credential.tokenId) || stdoutText.includes(credential.tokenSecret) || stderrText.includes(credential.tokenId) || stderrText.includes(credential.tokenSecret)) {
          return complete(current, grant, { ...interpreterAudit, disposition: "credential_echo", stderrByteLength, stderrSha256, exitCode: child.exitCode, ...(child.terminationSignal ? { terminationSignal: child.terminationSignal } : {}), startedAtMs: child.startedAtMs, reason: "credential_echo" }, held(grant, "credential_echo"));
        }
        if (!active(grant)) return complete(current, grant, { ...interpreterAudit, disposition: "grant_expired", stderrByteLength, stderrSha256, exitCode: child.exitCode, startedAtMs: child.startedAtMs, reason: "grant_expired" }, held(grant, "grant_expired"));
        let stdout: ModalBillingArtifactReference | undefined;
        const rawSha256 = sha256(child.stdout); const key = `modal-billing/${requested.reportRequestSha256}/${attempt}/stdout`;
        try {
          stdout = await input.artifacts.createImmutable({ key, bytes: child.stdout, sha256: rawSha256 });
          if (!await validArtifact(stdout, key, rawSha256)) throw new Error("MODAL_BILLING_ARTIFACT_BINDING_INVALID");
        } catch { return complete(current, grant, { ...interpreterAudit, disposition: "artifact_unavailable", stderrByteLength, stderrSha256, exitCode: child.exitCode, startedAtMs: child.startedAtMs, reason: "artifact_unavailable" }, held(grant, "artifact_unavailable")); }
        if (child.disposition !== "passed") return complete(current, grant, { ...interpreterAudit, disposition: child.disposition, stdout, stdoutSha256: rawSha256, stderrByteLength, stderrSha256, exitCode: child.exitCode, ...(child.terminationSignal ? { terminationSignal: child.terminationSignal } : {}), startedAtMs: child.startedAtMs, reason: "child_failure" }, held(grant, "child_failure"));
        const derived = derive(child.stdout, grant);
        return complete(current, grant, { ...interpreterAudit, disposition: child.disposition, stdout, stdoutSha256: rawSha256, stderrByteLength, stderrSha256, exitCode: child.exitCode, startedAtMs: child.startedAtMs, ...(derived.reason === "report_invalid" ? {} : { envelopeSha256: derived.envelopeSha256, rowIdentitiesSha256: derived.rowIdentitiesSha256, coverage: derived.coverage }), reason: derived.reason }, held(grant, derived.reason, derived.reason === "finality_unproven" ? derived.observedMicros : undefined));
      } finally { await prepared.close(); }
    },
  });
}
