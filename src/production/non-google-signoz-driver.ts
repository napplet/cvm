import { z } from "zod";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Origin = z.string().url().refine(value => new URL(value).protocol === "https:");
export const NonGoogleSigNozReferenceSchema = z.object({
  baseOrigin: Origin, ingestionKeyPath: z.string().min(1).refine(value => value.startsWith("/")), queryKeyPath: z.string().min(1).refine(value => value.startsWith("/")),
  collectorConfigSha256: Digest, serviceName: z.string().min(1).max(128), queryTemplateVersion: z.literal("v1"),
}).strict();
export type NonGoogleSigNozReference = z.infer<typeof NonGoogleSigNozReferenceSchema>;
export type NonGoogleSigNozHttp = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type NonGoogleTelemetryWindow = Readonly<{ observations: readonly unknown[]; metricSeriesCount: number; rejectedCanaries: boolean }>;

/** Native OTLP/SigNoz v5 client. It never treats journal state as collector
 * data: emit acknowledgement and query response are separate authenticated I/O. */
export class NonGoogleSigNozDriver {
  readonly reference: NonGoogleSigNozReference;
  constructor(reference: NonGoogleSigNozReference, private readonly http: NonGoogleSigNozHttp = fetch, private readonly readSecret: (path: string) => Promise<string> = async () => { throw new Error("NON_GOOGLE_SIGNOZ_SECRET_RESOLVER_REQUIRED"); }) {
    this.reference = Object.freeze(NonGoogleSigNozReferenceSchema.parse(reference)); Object.freeze(this);
  }
  async emitOtlp(payload: Uint8Array): Promise<void> {
    if (payload.byteLength === 0 || payload.byteLength > 1024 * 1024) throw new Error("NON_GOOGLE_OTLP_PAYLOAD_INVALID");
    const key = await this.#secret(this.reference.ingestionKeyPath);
    const body = Uint8Array.from(payload).buffer;
    const response = await this.http(new URL("/v1/traces", this.reference.baseOrigin), { method: "POST", headers: { "content-type": "application/x-protobuf", "signoz-access-token": key }, body });
    if (!response.ok) throw new Error(`NON_GOOGLE_OTLP_HTTP_${response.status}`);
  }
  async emitOtlpJson(payload: unknown): Promise<void> {
    const encoded = JSON.stringify(payload);
    if (encoded.length === 0 || encoded.length > 1024 * 1024) throw new Error("NON_GOOGLE_OTLP_PAYLOAD_INVALID");
    const key = await this.#secret(this.reference.ingestionKeyPath);
    const response = await this.http(new URL("/v1/traces", this.reference.baseOrigin), { method: "POST", headers: { "content-type": "application/json", "signoz-access-token": key }, body: encoded });
    if (!response.ok) throw new Error(`NON_GOOGLE_OTLP_HTTP_${response.status}`);
  }
  async queryRange(input: Readonly<{ start: number; end: number; candidateSha256: string; topologySha256: string }>): Promise<NonGoogleTelemetryWindow> {
    if (!Number.isFinite(input.start) || !Number.isFinite(input.end) || input.end < input.start) throw new Error("NON_GOOGLE_SIGNOZ_RANGE_INVALID");
    Digest.parse(input.candidateSha256); Digest.parse(input.topologySha256);
    const key = await this.#secret(this.reference.queryKeyPath);
    const response = await this.http(new URL("/api/v5/query_range", this.reference.baseOrigin), { method: "POST", headers: { "content-type": "application/json", "SIGNOZ-API-KEY": key }, body: JSON.stringify({ start: input.start, end: input.end, version: this.reference.queryTemplateVersion, filters: { service_name: this.reference.serviceName, candidate_sha256: input.candidateSha256, topology_sha256: input.topologySha256 } }) });
    if (!response.ok) throw new Error(`NON_GOOGLE_SIGNOZ_HTTP_${response.status}`);
    const parsed = z.object({ data: z.object({ series: z.array(z.unknown()) }).passthrough() }).passthrough().parse(await response.json());
    const observations = parsed.data.series;
    const rejectedCanaries = observations.every(row => JSON.stringify(row).includes("canary") === false);
    return Object.freeze({ observations: Object.freeze(observations), metricSeriesCount: observations.length, rejectedCanaries });
  }
  async #secret(path: string): Promise<string> { const value = (await this.readSecret(path)).trim(); if (value.length === 0) throw new Error("NON_GOOGLE_SIGNOZ_SECRET_EMPTY"); return value; }
}
