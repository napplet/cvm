import { canonicalJson } from "../promotion/schema";
import { evaluateAdmission, type AdmissionDecision, type AdmissionHooks, type TokenCounter } from "./admission-policy";

const RISK_TIMEOUT_MS = 100;

export const RISK_POLICY_INITIAL = Object.freeze({
  policyVersion: "phase-02-risk-2026-08-04",
  admissionPolicyVersion: "phase-02-policy-2026-08-04",
  detectorTimeoutMs: RISK_TIMEOUT_MS,
  rejectionSignals: Object.freeze(["JAILBREAK", "PROMPT_INJECTION"] as const),
} as const);

export type RiskSignalId = typeof RISK_POLICY_INITIAL.rejectionSignals[number];
export type RiskSignal = Readonly<{ id: RiskSignalId; severity: "high" }>;
export type RiskSignalDetector = Readonly<{
  version: string;
  detect(idea: string, signal: AbortSignal): unknown | Promise<unknown>;
}>;

export type RiskEvidence = Readonly<{
  ruleId: string;
  safeSummary: string;
  inputSha256?: string;
  inputLengths?: Readonly<{ utf8Bytes: number; codePoints: number; graphemes: number; inputTokens?: number; lines: number; maxLineCodePoints: number }>;
  detectorVersion: string;
  latencyClass: "not-invoked" | "within-bound" | "timeout" | "fault";
  signals: readonly RiskSignal[];
  identity: string;
}>;

export type RiskDecision = Readonly<{
  status: "accepted" | "denied";
  code: "RISK_ACCEPTED" | "RISK_POLICY_REJECTED" | "RISK_CLASSIFIER_UNAVAILABLE" | AdmissionDecision["code"];
  policy: typeof RISK_POLICY_INITIAL;
  grants: readonly string[];
  signals: readonly RiskSignal[];
  evidence: RiskEvidence;
}>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validSignal(value: unknown): value is RiskSignal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && (record.id === "JAILBREAK" || record.id === "PROMPT_INJECTION")
    && record.severity === "high";
}

function canonicalSignals(value: unknown): readonly RiskSignal[] | undefined {
  if (!Array.isArray(value) || !value.every(validSignal)) return undefined;
  const unique = new Map<RiskSignalId, RiskSignal>();
  for (const signal of value) unique.set(signal.id, { id: signal.id, severity: signal.severity });
  return deepFreeze([...unique.values()].sort((left, right) => left.id.localeCompare(right.id)));
}

async function detectWithinBound(detector: RiskSignalDetector, idea: string): Promise<{ kind: "ok"; signals: readonly RiskSignal[] } | { kind: "timeout" | "fault" }> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutResult = new Promise<{ kind: "timeout" }>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort("risk detector timeout");
        resolve({ kind: "timeout" });
      }, RISK_POLICY_INITIAL.detectorTimeoutMs);
    });
    const detectorResult = Promise.resolve(detector.detect(idea, controller.signal)).then((value) => ({ kind: "response" as const, value }), () => ({ kind: "fault" as const }));
    const result = await Promise.race([detectorResult, timeoutResult]);
    if (result.kind === "timeout" || result.kind === "fault") return result;
    const signals = canonicalSignals(result.value);
    return signals ? { kind: "ok", signals } : { kind: "fault" };
  } catch {
    return { kind: "fault" };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function baseGrantCopy(baseGrant: readonly string[]): readonly string[] {
  // The coordinator supplies this fixed grant. A detector result is never used
  // as an input here, ensuring all outputs remain subsets of this value.
  return deepFreeze([...baseGrant]);
}

async function evidence(
  code: RiskDecision["code"],
  admission: AdmissionDecision,
  detectorVersion: string,
  latencyClass: RiskEvidence["latencyClass"],
  signals: readonly RiskSignal[],
): Promise<RiskEvidence> {
  const payload = {
    ruleId: code === "RISK_POLICY_REJECTED" ? "D-26-RISK-RESTRICTIVE" : code === "RISK_CLASSIFIER_UNAVAILABLE" ? "D-27-RISK-UNAVAILABLE" : "D-26-RISK-CLEAN",
    safeSummary: code === "RISK_ACCEPTED" ? "risk signals accepted without authority expansion" : `risk evaluation denied: ${code}`,
    inputSha256: admission.evidence.inputSha256,
    inputLengths: admission.metrics,
    detectorVersion,
    latencyClass,
    signals,
  };
  return deepFreeze({ ...payload, identity: await sha256(payload) });
}

function admissionDenial(admission: AdmissionDecision): Promise<RiskDecision> {
  return evidence(admission.code, admission, "not-invoked", "not-invoked", []).then((record) => deepFreeze({
    status: "denied",
    code: admission.code,
    policy: RISK_POLICY_INITIAL,
    grants: deepFreeze([]),
    signals: deepFreeze([]),
    evidence: record,
  }));
}

/**
 * Evaluates hard text admission before a bounded detector. Detector output is
 * observability only: it may deny, but no return value can add a capability,
 * alter policy, or bypass an admission denial.
 */
export async function evaluateRisk(
  input: unknown,
  tokenCounter: TokenCounter,
  detector: RiskSignalDetector,
  baseGrant: readonly string[],
  hooks?: AdmissionHooks,
): Promise<RiskDecision> {
  const admission = await evaluateAdmission(input, tokenCounter, hooks);
  if (admission.status === "denied") return admissionDenial(admission);

  const detected = await detectWithinBound(detector, admission.idea!);
  if (detected.kind !== "ok") {
    const record = await evidence("RISK_CLASSIFIER_UNAVAILABLE", admission, detector.version, detected.kind, []);
    return deepFreeze({ status: "denied", code: "RISK_CLASSIFIER_UNAVAILABLE", policy: RISK_POLICY_INITIAL, grants: deepFreeze([]), signals: deepFreeze([]), evidence: record });
  }
  if (detected.signals.length > 0) {
    const record = await evidence("RISK_POLICY_REJECTED", admission, detector.version, "within-bound", detected.signals);
    return deepFreeze({ status: "denied", code: "RISK_POLICY_REJECTED", policy: RISK_POLICY_INITIAL, grants: deepFreeze([]), signals: detected.signals, evidence: record });
  }
  const grants = baseGrantCopy(baseGrant);
  const record = await evidence("RISK_ACCEPTED", admission, detector.version, "within-bound", detected.signals);
  return deepFreeze({ status: "accepted", code: "RISK_ACCEPTED", policy: RISK_POLICY_INITIAL, grants, signals: detected.signals, evidence: record });
}
