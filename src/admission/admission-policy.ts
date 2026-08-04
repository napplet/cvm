import { PHASE_02_POLICY_INITIAL } from "../policy/phase-02-policy";

const SEGMENTER_LOCALE = "und";
const SEGMENTER_GRANULARITY = "grapheme" as const;

export type AdmissionDenialCode =
  | "INPUT_REQUIRED"
  | "INPUT_ENVELOPE_INVALID"
  | "INPUT_MALFORMED_UNICODE"
  | "INPUT_DISALLOWED_CONTROL"
  | "INPUT_NOT_NFC"
  | "INPUT_UTF8_BYTE_LIMIT"
  | "INPUT_CODE_POINT_LIMIT"
  | "INPUT_GRAPHEME_LIMIT"
  | "INPUT_TOKEN_LIMIT"
  | "INPUT_LINE_LIMIT"
  | "INPUT_LINE_CODE_POINT_LIMIT"
  | "INPUT_EMBEDDED_DATA"
  | "INPUT_REPOSITORY_OR_CODE"
  | "INPUT_ALTERNATE_CONTROL"
  | "TOKEN_COUNT_UNAVAILABLE";

export interface TokenCounter {
  readonly version: string;
  count(idea: string): number | Promise<number>;
}

export interface AdmissionHooks {
  readonly allocations?: number;
  readonly models?: number;
  readonly billable?: number;
  readonly workers?: number;
}

export type AdmissionPolicySnapshot = Readonly<{
  policyVersion: typeof PHASE_02_POLICY_INITIAL.policyVersion;
  tokenCounterVersion: string;
  segmenterLocale: typeof SEGMENTER_LOCALE;
  segmenterGranularity: typeof SEGMENTER_GRANULARITY;
  limits: typeof PHASE_02_POLICY_INITIAL.admission;
}>;

export type AdmissionMetrics = Readonly<{
  utf8Bytes: number;
  codePoints: number;
  graphemes: number;
  inputTokens?: number;
  lines: number;
  maxLineCodePoints: number;
}>;

export type AdmissionEvidence = Readonly<{
  ruleId: string;
  safeSummary: string;
  inputSha256?: string;
  metrics?: AdmissionMetrics;
}>;

export type AdmissionDecision = Readonly<{
  status: "accepted" | "denied";
  code: "ADMITTED" | AdmissionDenialCode;
  policy: AdmissionPolicySnapshot;
  evidence: AdmissionEvidence;
  metrics?: AdmissionMetrics;
  /** Present only for an accepted exact NFC string. */
  idea?: string;
}>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasDisallowedControl(value: string): boolean {
  // A line-feed is the sole permitted control: policy line limits use it as syntax.
  return /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\ufeff\u2028\u2029]/u.test(value);
}

function structuralCode(value: string): AdmissionDenialCode | undefined {
  if (/^\s*(?:data:|file:|-----BEGIN [A-Z0-9 -]+-----)/iu.test(value)) return "INPUT_EMBEDDED_DATA";
  if (/\b(?:git\s+clone|diff\s+--git|git@[^\s]+:|https?:\/\/(?:www\.)?(?:github|gitlab|bitbucket)\.com\/[^\s]+(?:\.git)?|repository\s*:|repo\s*:)/iu.test(value)) return "INPUT_REPOSITORY_OR_CODE";
  if (/^\s*(?:\{\s*"(?:role|messages|system|tool)"|<\/?(?:system|tool|instruction)\b|\[\s*\{\s*"role")/iu.test(value)) return "INPUT_ALTERNATE_CONTROL";
  return undefined;
}

function ruleFor(code: AdmissionDenialCode | "ADMITTED"): string {
  const rules: Record<AdmissionDenialCode | "ADMITTED", string> = {
    ADMITTED: "D-24-CANONICAL-TEXT",
    INPUT_REQUIRED: "D-24-REQUIRED",
    INPUT_ENVELOPE_INVALID: "D-24-ONE-IDEA",
    INPUT_MALFORMED_UNICODE: "D-25-WELL-FORMED-UNICODE",
    INPUT_DISALLOWED_CONTROL: "D-25-CONTROL-CHARACTERS",
    INPUT_NOT_NFC: "D-24-NFC",
    INPUT_UTF8_BYTE_LIMIT: "D-24-UTF8-BYTES",
    INPUT_CODE_POINT_LIMIT: "D-24-CODE-POINTS",
    INPUT_GRAPHEME_LIMIT: "D-24-GRAPHEMES",
    INPUT_TOKEN_LIMIT: "D-24-TOKENS",
    INPUT_LINE_LIMIT: "D-24-LINES",
    INPUT_LINE_CODE_POINT_LIMIT: "D-24-LINE-CODE-POINTS",
    INPUT_EMBEDDED_DATA: "D-25-EMBEDDED-DATA",
    INPUT_REPOSITORY_OR_CODE: "D-25-REPOSITORY-OR-CODE",
    INPUT_ALTERNATE_CONTROL: "D-25-ALTERNATE-CONTROL",
    TOKEN_COUNT_UNAVAILABLE: "D-24-TOKEN-COUNTER",
  };
  return rules[code];
}

function safeSummary(code: AdmissionDenialCode | "ADMITTED"): string {
  return code === "ADMITTED" ? "canonical text accepted" : `text admission denied: ${code}`;
}

async function sha256Utf8(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function snapshot(tokenCounter: TokenCounter): AdmissionPolicySnapshot {
  return deepFreeze({
    policyVersion: PHASE_02_POLICY_INITIAL.policyVersion,
    tokenCounterVersion: tokenCounter.version,
    segmenterLocale: SEGMENTER_LOCALE,
    segmenterGranularity: SEGMENTER_GRANULARITY,
    limits: PHASE_02_POLICY_INITIAL.admission,
  });
}

/** Measures a canonical string with the policy's pinned UTF-8/scalar/grapheme contract. */
export function measureCanonicalText(idea: string): Readonly<{ metrics: AdmissionMetrics }> {
  const codePoints = Array.from(idea);
  const lines = idea.split("\n");
  const metrics: AdmissionMetrics = deepFreeze({
    utf8Bytes: new TextEncoder().encode(idea).byteLength,
    codePoints: codePoints.length,
    graphemes: [...new Intl.Segmenter(SEGMENTER_LOCALE, { granularity: SEGMENTER_GRANULARITY }).segment(idea)].length,
    lines: lines.length,
    maxLineCodePoints: Math.max(0, ...lines.map((line) => Array.from(line).length)),
  });
  return deepFreeze({ metrics });
}

function denied(code: AdmissionDenialCode, policy: AdmissionPolicySnapshot, metrics?: AdmissionMetrics, inputSha256?: string): AdmissionDecision {
  return deepFreeze({
    status: "denied",
    code,
    policy,
    metrics,
    evidence: { ruleId: ruleFor(code), safeSummary: safeSummary(code), inputSha256, metrics },
  });
}

/**
 * The complete pre-allocation admission boundary. Hooks are intentionally
 * observational-only: this function must not allocate, call a model, bill, or
 * start a worker; callers may perform those operations only after `ADMITTED`.
 */
export async function evaluateAdmission(input: unknown, tokenCounter: TokenCounter, _hooks?: AdmissionHooks): Promise<AdmissionDecision> {
  const policy = snapshot(tokenCounter);
  if (!isPlainRecord(input) || Object.keys(input).length !== 1 || !("idea" in input)) return denied("INPUT_ENVELOPE_INVALID", policy);
  const idea = input.idea;
  if (typeof idea !== "string" || idea.trim().length === 0) return denied("INPUT_REQUIRED", policy);
  if (!isWellFormedUnicode(idea)) return denied("INPUT_MALFORMED_UNICODE", policy);
  if (hasDisallowedControl(idea)) return denied("INPUT_DISALLOWED_CONTROL", policy);
  if (idea !== idea.normalize("NFC")) return denied("INPUT_NOT_NFC", policy);

  const inputSha256 = await sha256Utf8(idea);
  const metrics = measureCanonicalText(idea).metrics;
  const limits = PHASE_02_POLICY_INITIAL.admission;
  if (metrics.utf8Bytes > limits.maxUtf8Bytes) return denied("INPUT_UTF8_BYTE_LIMIT", policy, metrics, inputSha256);
  if (metrics.codePoints > limits.maxCodePoints) return denied("INPUT_CODE_POINT_LIMIT", policy, metrics, inputSha256);
  if (metrics.graphemes > limits.maxGraphemes) return denied("INPUT_GRAPHEME_LIMIT", policy, metrics, inputSha256);
  if (metrics.lines > limits.maxLines) return denied("INPUT_LINE_LIMIT", policy, metrics, inputSha256);
  if (metrics.maxLineCodePoints > limits.maxCodePointsPerLine) return denied("INPUT_LINE_CODE_POINT_LIMIT", policy, metrics, inputSha256);
  const structure = structuralCode(idea);
  if (structure) return denied(structure, policy, metrics, inputSha256);

  let inputTokens: number;
  try {
    inputTokens = await tokenCounter.count(idea);
  } catch {
    return denied("TOKEN_COUNT_UNAVAILABLE", policy, metrics, inputSha256);
  }
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) return denied("TOKEN_COUNT_UNAVAILABLE", policy, metrics, inputSha256);
  const measured = deepFreeze({ ...metrics, inputTokens });
  if (inputTokens > limits.maxInputTokens) return denied("INPUT_TOKEN_LIMIT", policy, measured, inputSha256);
  return deepFreeze({
    status: "accepted",
    code: "ADMITTED",
    idea,
    policy,
    metrics: measured,
    evidence: { ruleId: ruleFor("ADMITTED"), safeSummary: safeSummary("ADMITTED"), inputSha256, metrics: measured },
  });
}
