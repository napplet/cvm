import { z } from "zod";
import {
  ReleaseAuthorizationRequestSchema,
  validateAuthorizationReceipt,
  validateAuthorizationRequest,
  type ReleaseAuthorizationReceipt,
  type ReleaseAuthorizationRequest,
} from "../authorization";
import { canonicalJson } from "../../promotion/schema";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
// Child operation ids append at most `:service:storage.googleapis.com`.
const OperationIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,90}$/u);
const ProjectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u);
const BillingAccountIdSchema = z.string().regex(/^billingAccounts\/[a-zA-Z0-9-]{3,128}$/u);
const ServiceSchema = z.string().regex(/^[a-z][a-z0-9.-]{2,127}$/u);

type BootstrapKind = "create_project" | "link_billing" | "enable_service";
type BootstrapStage = Readonly<{ kind: BootstrapKind; operationId: string; service?: string }>;

export type GcpBootstrapPort = Readonly<{
  /** Records the immutable original operation before any provider interaction. */
  persist(input: Readonly<{
    operationId: string;
    kind: BootstrapKind | "cleanup";
    authorizationRequestSha256: string;
    authorizationReceiptSha256: string;
    projectScopeSha256: string;
  }>): Promise<void>;
  /** Read-only reconciliation of the exact original operation/project. */
  observe(input: Readonly<{ operationId: string; projectId: string; billingAccountId: string; service?: string }>): Promise<Readonly<{ status: "completed" | "missing" | "pending" | "unknown" | "blocked" }>>;
  createProject(input: Readonly<{ operationId: string; projectId: string }>): Promise<void>;
  linkBilling(input: Readonly<{ operationId: string; projectId: string; billingAccountId: string }>): Promise<void>;
  enableService(input: Readonly<{ operationId: string; projectId: string; service: string }>): Promise<void>;
  /** Must delete only a run-owned project. Billing and shared APIs are never removed. */
  deleteProject(input: Readonly<{ operationId: string; projectId: string }>): Promise<void>;
}>;

export type GcpBootstrapInput = Readonly<{
  request: unknown;
  receipt: unknown;
  operationId: string;
  projectId: string;
  billingAccountId: string;
  accountScopeSha256: string;
  projectScopeSha256: string;
}>;

type AuthorizedInput = Readonly<{
  request: ReleaseAuthorizationRequest;
  receipt: ReleaseAuthorizationReceipt;
  operationId: string;
  projectId: string;
  billingAccountId: string;
  accountScopeSha256: string;
  projectScopeSha256: string;
}>;

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The digest is the only scope identity persisted or returned by this adapter. */
export function deriveGcpProjectScopeSha256(input: Readonly<{ projectId: string; billingAccountId: string; accountScopeSha256: string }>): Promise<string> {
  return sha256({ version: 1, provider: "gcp_bootstrap", projectId: ProjectIdSchema.parse(input.projectId), billingAccountId: BillingAccountIdSchema.parse(input.billingAccountId), accountScopeSha256: DigestSchema.parse(input.accountScopeSha256) });
}

function stages(input: AuthorizedInput): readonly BootstrapStage[] {
  const services = [...new Set(input.request.gcpEffects.apiEnablement.map((service) => ServiceSchema.parse(service)))].sort();
  return Object.freeze([
    { kind: "create_project", operationId: `${input.operationId}:project` },
    { kind: "link_billing", operationId: `${input.operationId}:billing`, service: "billing" },
    ...services.map((service) => ({ kind: "enable_service" as const, operationId: `${input.operationId}:service:${service}`, service })),
  ]);
}

async function authorize(input: GcpBootstrapInput, nowMs: number): Promise<AuthorizedInput> {
  let request: ReleaseAuthorizationRequest;
  let receipt: ReleaseAuthorizationReceipt;
  try {
    request = await validateAuthorizationRequest(input.request);
    receipt = await validateAuthorizationReceipt({ request, receipt: input.receipt, nowMs });
  } catch {
    throw new Error("GCP_BOOTSTRAP_AUTHORIZATION_INVALID");
  }

  const operationId = OperationIdSchema.safeParse(input.operationId);
  const projectId = ProjectIdSchema.safeParse(input.projectId);
  const billingAccountId = BillingAccountIdSchema.safeParse(input.billingAccountId);
  const accountScopeSha256 = DigestSchema.safeParse(input.accountScopeSha256);
  const projectScopeSha256 = DigestSchema.safeParse(input.projectScopeSha256);
  if (!operationId.success || !projectId.success || !billingAccountId.success || !accountScopeSha256.success || !projectScopeSha256.success
    || !request.gcpEffects.projectBootstrap || !request.gcpEffects.billing) throw new Error("GCP_BOOTSTRAP_SCOPE_INVALID");

  const derivedScope = await deriveGcpProjectScopeSha256({ projectId: projectId.data, billingAccountId: billingAccountId.data, accountScopeSha256: accountScopeSha256.data });
  const gcpScopes = request.providerScopes.filter((scope) => ["cloud_run", "gcs", "collector", "cloud_sql_postgres"].includes(scope.provider));
  if (gcpScopes.length === 0 || derivedScope !== projectScopeSha256.data || gcpScopes.some((scope) => scope.accountScopeSha256 !== accountScopeSha256.data || scope.projectScopeSha256 !== projectScopeSha256.data)) {
    throw new Error("GCP_BOOTSTRAP_SCOPE_INVALID");
  }
  return Object.freeze({ request, receipt, operationId: operationId.data, projectId: projectId.data, billingAccountId: billingAccountId.data, accountScopeSha256: accountScopeSha256.data, projectScopeSha256: projectScopeSha256.data });
}

async function persist(port: GcpBootstrapPort, input: AuthorizedInput, operationId: string, kind: BootstrapKind | "cleanup"): Promise<void> {
  await port.persist({ operationId, kind, authorizationRequestSha256: input.request.authorizationRequestSha256, authorizationReceiptSha256: input.receipt.authorizationReceiptSha256, projectScopeSha256: input.projectScopeSha256 });
}

async function reconcile(port: GcpBootstrapPort, input: AuthorizedInput, stage: BootstrapStage): Promise<"completed" | "missing"> {
  const result = await port.observe({ operationId: stage.operationId, projectId: input.projectId, billingAccountId: input.billingAccountId, ...(stage.service ? { service: stage.service } : {}) });
  if (result.status === "completed" || result.status === "missing") return result.status;
  throw new Error(result.status === "blocked" ? "GCP_BOOTSTRAP_OPERATION_BLOCKED" : "GCP_BOOTSTRAP_RECONCILIATION_PENDING");
}

/**
 * Native GCP bootstrap composition. The port is injected by a protected runner;
 * this module never constructs gcloud clients, reads credentials, invokes a
 * command, or permits effects until the exact v2 receipt validates.
 */
export function createGcpBootstrapAdapter(options: Readonly<{ port: GcpBootstrapPort; now?: () => number }>) {
  const now = options.now ?? Date.now;
  return Object.freeze({
    async plan(input: GcpBootstrapInput) {
      const authorized = await authorize(input, now());
      return Object.freeze({
        status: "planned" as const,
        authorizationRequestSha256: authorized.request.authorizationRequestSha256,
        projectScopeSha256: authorized.projectScopeSha256,
        effects: stages(authorized).map((stage) => Object.freeze({ kind: stage.kind, operationId: stage.operationId, ...(stage.service ? { service: stage.service } : {}) })),
      });
    },
    async apply(input: GcpBootstrapInput) {
      const authorized = await authorize(input, now());
      for (const stage of stages(authorized)) {
        await persist(options.port, authorized, stage.operationId, stage.kind);
        if (await reconcile(options.port, authorized, stage) === "completed") continue;
        if (stage.kind === "create_project") await options.port.createProject({ operationId: stage.operationId, projectId: authorized.projectId });
        else if (stage.kind === "link_billing") await options.port.linkBilling({ operationId: stage.operationId, projectId: authorized.projectId, billingAccountId: authorized.billingAccountId });
        else await options.port.enableService({ operationId: stage.operationId, projectId: authorized.projectId, service: stage.service! });
      }
      return Object.freeze({ status: "completed" as const, operationId: authorized.operationId, projectScopeSha256: authorized.projectScopeSha256, resourceIdentitySha256: await sha256({ projectId: authorized.projectId, projectScopeSha256: authorized.projectScopeSha256 }) });
    },
    async observe(input: GcpBootstrapInput) {
      const authorized = await authorize(input, now());
      const observations = await Promise.all(stages(authorized).map(async (stage) => Object.freeze({ operationId: stage.operationId, status: await reconcile(options.port, authorized, stage) })));
      return Object.freeze({ status: observations.every((entry) => entry.status === "completed") ? "completed" as const : "pending" as const, operationId: authorized.operationId, observations });
    },
    async cleanup(input: GcpBootstrapInput & Readonly<{ runOwnedProjectId: string }>) {
      const authorized = await authorize(input, now());
      if (ProjectIdSchema.safeParse(input.runOwnedProjectId).data !== authorized.projectId) throw new Error("GCP_BOOTSTRAP_CLEANUP_SCOPE_INVALID");
      const operationId = `${authorized.operationId}:cleanup`;
      await persist(options.port, authorized, operationId, "cleanup");
      const existing = await options.port.observe({ operationId, projectId: authorized.projectId, billingAccountId: authorized.billingAccountId });
      if (existing.status === "missing") return Object.freeze({ status: "cleaned" as const, operationId });
      if (existing.status !== "completed") throw new Error(existing.status === "blocked" ? "GCP_BOOTSTRAP_OPERATION_BLOCKED" : "GCP_BOOTSTRAP_RECONCILIATION_PENDING");
      await options.port.deleteProject({ operationId, projectId: authorized.projectId });
      return Object.freeze({ status: "cleaned" as const, operationId });
    },
  });
}

// Keep schema import live at this security boundary: only exact v2 requests are accepted.
void ReleaseAuthorizationRequestSchema;
