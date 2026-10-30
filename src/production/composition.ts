import type { ContextVmFundingAdapter } from "../contextvm/adapter";
import type { FundedCore } from "../phase-03/funded-core";
import type { MeteredGenerationService } from "../phase-04/metered-generation-service";
import { assertPostgresOperationJournal, type PostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import type { ProductionSessionRuntime } from "../release/deployment/production-session";
import type { WorkerBenchmarkSample } from "../admission/benchmark";
import { OAuth2Client } from "google-auth-library";
import { assertProductionReferenceGraph, loadProductionConfig, type ProductionConfig } from "./config";
import type { ProductionMigrationControl } from "./migration-control";

export const PRODUCTION_HTTP_ROUTES = Object.freeze([
  "GET /healthz",
  "GET /static/*",
  "GET /preview/*",
  "GET /artifacts/*",
  "OPTIONS /preview/nip5d-direct-v1/*",
  "OPTIONS /artifacts/nip5d-direct-v1/*",
  "GET /internal/admission/operations/:operationId",
  "POST /internal/certification/operations",
  "GET /internal/certification/operations/:operationId",
  "POST /internal/migration/operations",
  "GET /internal/migration/operations/:operationId",
] as const);

export type ProductionRoute = typeof PRODUCTION_HTTP_ROUTES[number];
export type ProductionRuntimeAuthority = Readonly<{
  /** This marker is emitted only by the sealed production factory. */
  authority: "production-real";
  funded: FundedCore;
  generation: Pick<MeteredGenerationService, "startSession" | "reviseSession" | "sessionStatus" | "reconcileOutstandingWakeDispatches">;
  journal: PostgresOperationJournal;
  /** The exact receipt-bound certification graph used by Plan 67. */
  session: ProductionSessionRuntime;
  observeAdmissionOperation(input: Readonly<{ operationId: string }>): Promise<WorkerBenchmarkSample | undefined>;
  certification: PrivateCertificationControl;
  /** Receipt-bound migration capability; no generic admin operation exists. */
  migration: ProductionMigrationControl;
  close(): Promise<void>;
}>;

const runtimeAuthorities = new WeakSet<object>();
/** Only deployment assembly can mint the runtime capability.  It closes the
 * raw-object injection seam while retaining a small deterministic test seam. */
export function sealProductionRuntimeAuthority(input: ProductionRuntimeAuthority): ProductionRuntimeAuthority {
  if (!input || input.authority !== "production-real" || !input.session || typeof input.close !== "function" || typeof input.observeAdmissionOperation !== "function" || !input.certification || typeof input.certification.execute !== "function" || typeof input.certification.observe !== "function" || !input.migration || typeof input.migration.execute !== "function" || typeof input.migration.observe !== "function") throw new Error("PRODUCTION_RUNTIME_AUTHORITY_REQUIRED");
  assertPostgresOperationJournal(input.journal);
  runtimeAuthorities.add(input);
  return Object.freeze(input);
}
export function assertProductionRuntimeAuthority(value: unknown): asserts value is ProductionRuntimeAuthority {
  if (!value || typeof value !== "object" || !runtimeAuthorities.has(value)) throw new Error("PRODUCTION_RUNTIME_AUTHORITY_REQUIRED");
}

export type PrivateOperatorIdentity = Readonly<{ verify(input: Readonly<{ authorization?: string; audience: string }>): Promise<boolean> }>;
/** Verifies Cloud Run audience-bound Google ID tokens; OAuth access tokens and
 * arbitrary bearer strings are intentionally rejected. */
export function createGooglePrivateOperatorIdentity(input: Readonly<{ serviceAccount: string }>): PrivateOperatorIdentity {
  if (!/^[a-z][a-z0-9-]{2,62}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/u.test(input.serviceAccount)) throw new Error("PRODUCTION_OPERATOR_PRINCIPAL_INVALID");
  const verifier = new OAuth2Client();
  return Object.freeze({
    async verify(request) {
      const match = /^Bearer ([A-Za-z0-9._-]{20,4096})$/u.exec(request.authorization ?? "");
      if (!match) return false;
      try {
        const ticket = await verifier.verifyIdToken({ idToken: match[1]!, audience: request.audience });
        return ticket.getPayload()?.email === input.serviceAccount && ticket.getPayload()?.email_verified === true;
      } catch { return false; }
    },
  });
}
export type PrivateCertificationControl = Readonly<{
  execute(input: unknown): Promise<unknown>;
  observe(input: Readonly<{ operationId: string }>): Promise<unknown>;
}>;

export type ProductionRuntime = Readonly<{
  config: ProductionConfig;
  contextvm: ContextVmFundingAdapter;
  routes: readonly ProductionRoute[];
  reconcileOnce(accountId: string): ReturnType<ProductionRuntimeAuthority["generation"]["reconcileOutstandingWakeDispatches"]>;
  handle(request: Request): Promise<Response>;
  shutdown(): Promise<void>;
}>;

function response(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function operationId(pathname: string): string | undefined {
  const found = /^\/internal\/certification\/operations\/([a-z][a-z0-9:_-]{2,127})$/u.exec(pathname);
  return found?.[1];
}
function migrationOperationId(pathname: string): string | undefined {
  const found = /^\/internal\/migration\/operations\/(migration:(?:backup|restore-test|cutover|rollback):[a-f0-9]{24})$/u.exec(pathname);
  return found?.[1];
}

/**
 * The server composition has no HTTP generation endpoint. ContextVM owns that
 * public boundary; HTTP is intentionally limited to static/signed delivery and
 * authenticated internal certification operations.
 */
export function createProductionRuntime(input: Readonly<{
  config: unknown;
  authority: ProductionRuntimeAuthority;
  operatorIdentity: PrivateOperatorIdentity;
  staticHandler?: (request: Request) => Promise<Response>;
  previewHandler?: (request: Request) => Promise<Response>;
  artifactHandler?: (request: Request) => Promise<Response>;
}>): ProductionRuntime {
  const config = loadProductionConfig(input.config);
  assertProductionReferenceGraph(config);
  assertProductionRuntimeAuthority(input.authority);
  assertPostgresOperationJournal(input.authority.journal);
  const contextvm = input.authority.funded.contextvm;
  if (!contextvm || input.authority.funded.mode !== "configured" || input.authority.funded.externalSurfaces.contextvm !== "configured") {
    throw new Error("PRODUCTION_CONTEXTVM_GENERATION_REQUIRED");
  }
  if (typeof input.authority.generation.startSession !== "function" || typeof input.authority.generation.reconcileOutstandingWakeDispatches !== "function") {
    throw new Error("PRODUCTION_GENERATION_AUTHORITY_REQUIRED");
  }
  const authenticate = async (request: Request) => input.operatorIdentity.verify({ authorization: request.headers.get("authorization") ?? undefined, audience: config.operator.privateControlAudience });
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return response(200, { status: "ok", realm: config.realm });
    if (request.method === "GET" && url.pathname.startsWith("/static/")) return input.staticHandler ? input.staticHandler(request) : response(404, { code: "STATIC_NOT_CONFIGURED" });
    if (["GET", "OPTIONS"].includes(request.method) && url.pathname.startsWith("/preview/")) return input.previewHandler ? input.previewHandler(request) : response(404, { code: "PREVIEW_NOT_CONFIGURED" });
    if (["GET", "OPTIONS"].includes(request.method) && url.pathname.startsWith("/artifacts/")) return input.artifactHandler ? input.artifactHandler(request) : response(404, { code: "ARTIFACT_NOT_CONFIGURED" });
    const admission = /^\/internal\/admission\/operations\/([a-z][a-z0-9:_-]{2,127})$/u.exec(url.pathname)?.[1];
    if (request.method === "GET" && admission) {
      if (!await authenticate(request)) return response(401, { code: "PRIVATE_OPERATOR_AUTH_REQUIRED" });
      const result = await input.authority.observeAdmissionOperation({ operationId: admission });
      return result ? response(200, result) : response(404, { code: "ORIGINAL_OPERATION_NOT_FOUND" });
    }
    const id = operationId(url.pathname);
    if ((request.method === "POST" && url.pathname === "/internal/certification/operations") || (request.method === "GET" && id)) {
      if (!await authenticate(request)) return response(401, { code: "PRIVATE_OPERATOR_AUTH_REQUIRED" });
      if (request.method === "GET" && id) return response(200, await input.authority.certification.observe({ operationId: id }));
      const body = await request.json().catch(() => undefined) as Record<string, unknown> | undefined;
      if (!body || typeof body.operationId !== "string" || typeof body.kind !== "string" || typeof body.requestSha256 !== "string" || typeof body.candidateSha256 !== "string" || typeof body.topologySha256 !== "string" || typeof body.authorizationRequestSha256 !== "string") return response(400, { code: "PRIVATE_OPERATION_REQUEST_INVALID" });
      return response(200, await input.authority.certification.execute(body));
    }
    const migrationId = migrationOperationId(url.pathname);
    if ((request.method === "POST" && url.pathname === "/internal/migration/operations") || (request.method === "GET" && migrationId)) {
      if (!await authenticate(request)) return response(401, { code: "PRIVATE_OPERATOR_AUTH_REQUIRED" });
      if (request.method === "GET" && migrationId) return response(200, await input.authority.migration.observe({ operationId: migrationId }));
      const body = await request.json().catch(() => undefined);
      if (!body || typeof body !== "object") return response(400, { code: "MIGRATION_OPERATION_REQUEST_INVALID" });
      return response(200, await input.authority.migration.execute(body));
    }
    return response(404, { code: "ROUTE_NOT_FOUND" });
  };
  return Object.freeze({ config, contextvm, routes: PRODUCTION_HTTP_ROUTES, reconcileOnce: (accountId) => input.authority.generation.reconcileOutstandingWakeDispatches(accountId), handle, shutdown: () => input.authority.close() });
}
