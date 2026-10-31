import { z } from "zod";

import { canonicalJson } from "../promotion/schema";
import { PostgresOperationJournal, assertPostgresOperationJournal } from "../release/deployment/postgres-operation-journal";
import { CertificationEdgeKindSchema, CertificationEdgePayloadSchemas, type CertificationEdgeKind } from "./certification-edge-protocol";
import { ProductionCertificationEdgeService, assertProductionCertificationEdgeService } from "./certification-edge";
import { assertNonGoogleInvocationAuthority, type NonGoogleInvocationAuthority } from "./non-google-invocation-authority";

const Digest = z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase());
const Id = z.string().regex(/^[a-z][a-z0-9:_-]{2,127}$/u);
export const NonGoogleSuccessorControlCommandSchema = z.object({ operationId: Id, kind: CertificationEdgeKindSchema, payload: z.unknown(), candidateSha256: Digest, topologySha256: Digest, roleCostBoundSha256: Digest, requestSha256: Digest }).strict();
const StoredSchema = z.object({ operationId: Id, kind: CertificationEdgeKindSchema, requestSha256: Digest, candidateSha256: Digest, topologySha256: Digest, roleCostBoundSha256: Digest, payload: z.unknown(), state: z.enum(["pending", "completed", "unknown", "failed"]), result: z.unknown().optional() }).strict();
export type NonGoogleSuccessorControlObservation = Readonly<z.infer<typeof StoredSchema>>;

function scopeFor(kind: CertificationEdgeKind): string {
  if (kind.startsWith("edge.security.")) return "edge.security";
  if (kind.startsWith("edge.supply.")) return "edge.supply";
  if (kind.startsWith("edge.payment.")) return "edge.payment";
  return "edge.publication";
}
function unresolvedModel(value: unknown): boolean { return !!value && typeof value === "object" && (value as { status?: unknown }).status === "unknown"; }
async function digest(value: unknown): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)))), byte => byte.toString(16).padStart(2, "0")).join(""); }

/** Separate successor state machine. It deliberately does not import or call
 * the legacy ReleaseAuthorization/Cloud Run control path. Durable original
 * operation identity is claimed before a first dispatch; retry only observes
 * the same stored command. */
export class NonGoogleSuccessorControl {
  constructor(private readonly input: Readonly<{ authority: NonGoogleInvocationAuthority; journal: PostgresOperationJournal; edge: ProductionCertificationEdgeService; candidateSha256: string; topologySha256: string; roleCostBoundSha256: string; authorizationRequestSha256: string }>) {
    assertNonGoogleInvocationAuthority(input.authority); assertPostgresOperationJournal(input.journal); assertProductionCertificationEdgeService(input.edge);
    Digest.parse(input.candidateSha256); Digest.parse(input.topologySha256); Digest.parse(input.roleCostBoundSha256); Digest.parse(input.authorizationRequestSha256);
  }
  async execute(raw: unknown): Promise<NonGoogleSuccessorControlObservation> {
    const command = NonGoogleSuccessorControlCommandSchema.parse(raw);
    const { requestSha256, ...unsigned } = command;
    if (requestSha256 !== await digest(unsigned)) throw new Error("NON_GOOGLE_SUCCESSOR_CONTROL_REQUEST_DIGEST_INVALID");
    this.#assert(command, false);
    const payload = CertificationEdgePayloadSchemas[command.kind].parse(command.payload);
    const pending = StoredSchema.parse({ ...command, payload, state: "pending" });
    const claim = await this.input.journal.claimBounded(command.operationId, command.requestSha256, pending, 64);
    const current = StoredSchema.parse(claim.record.value);
    if (!claim.claimed) return this.observe({ operationId: command.operationId, requestSha256: command.requestSha256 });
    try {
      const result = await this.input.edge.execute({ operationId: command.operationId, kind: command.kind, payload });
      const terminal = StoredSchema.parse(unresolvedModel(result) && command.kind === "edge.payment.model" ? { ...pending, state: "unknown" } : { ...pending, state: "completed", result });
      return StoredSchema.parse((await this.input.journal.compareAndSet(command.operationId, command.requestSha256, claim.record.revision, terminal))?.value ?? pending);
    } catch {
      const terminal = StoredSchema.parse({ ...pending, state: "unknown" });
      return StoredSchema.parse((await this.input.journal.compareAndSet(command.operationId, command.requestSha256, claim.record.revision, terminal))?.value ?? terminal);
    }
  }
  async observe(input: Readonly<{ operationId: string; requestSha256: string }>): Promise<NonGoogleSuccessorControlObservation> {
    const operationId = Id.parse(input.operationId), requestSha256 = Digest.parse(input.requestSha256);
    const record = await this.input.journal.read<unknown>(operationId);
    if (!record || record.identitySha256 !== requestSha256) throw new Error("NON_GOOGLE_SUCCESSOR_CONTROL_ORIGINAL_REQUIRED");
    const current = StoredSchema.parse(record.value);
    this.#assert(current, true);
    if ((current.state !== "pending" && current.state !== "unknown") || current.kind !== "edge.payment.model") return current;
    let result: unknown;
    try { result = await this.input.edge.reconcile({ operationId: current.operationId, kind: current.kind, payload: current.payload }); }
    catch { return current; }
    if (unresolvedModel(result)) return current;
    const terminal = StoredSchema.parse({ ...current, state: "completed", result });
    return StoredSchema.parse((await this.input.journal.compareAndSet(current.operationId, current.requestSha256, record.revision, terminal))?.value ?? (await this.input.journal.read<unknown>(operationId))?.value);
  }
  #assert(value: Readonly<{ kind: CertificationEdgeKind; candidateSha256: string; topologySha256: string; requestSha256: string; roleCostBoundSha256: string }>, originalRecorded: boolean): void {
    if (value.candidateSha256 !== this.input.candidateSha256 || value.topologySha256 !== this.input.topologySha256 || value.roleCostBoundSha256 !== this.input.roleCostBoundSha256) throw new Error("NON_GOOGLE_SUCCESSOR_CONTROL_BINDING_REQUIRED");
    // The signed v3 request is the successor grant identity. The separately
    // recomputed command digest remains the durable original-operation
    // identity; a GET control URL can never substitute either value.
    const facts = { scope: scopeFor(value.kind), effect: value.kind, candidateSha256: value.candidateSha256, topologySha256: value.topologySha256, requestSha256: this.input.authorizationRequestSha256, roleCostBoundSha256: value.roleCostBoundSha256 };
    if (originalRecorded) this.input.authority.assertOriginalObservation({ ...facts, originalRecorded: true }); else this.input.authority.assertDispatch(facts);
  }
}
