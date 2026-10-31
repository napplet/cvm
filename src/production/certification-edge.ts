import { ProductionDirectPublicationCertification } from "./direct-publication-certification";
import { canonicalJson } from "../promotion/schema";
import { z } from "zod";
import { DirectPublicationReferenceSchema } from "../certification/live/direct-publication-contract";
export { CertificationEdgeKindSchema, CertificationEdgePayloadSchemas, type CertificationEdgeKind, type ProductionCertificationEdgeCommand } from "./certification-edge-protocol";
import { CertificationEdgeKindSchema as EdgeKindSchema, CertificationEdgePayloadSchemas, type CertificationEdgeKind } from "./certification-edge-protocol";

import { assertProductionSessionBroker, type ProductionSessionBroker } from "../release/deployment/production-session-runtime";
import { ProductionPublicationCertification } from "./publication-certification";

const OperationIdSchema = z.string().regex(/^[a-z][a-z0-9:_-]{2,127}$/u);

const services = new WeakSet<object>();

/**
 * Controller-side edge dispatcher. The only injectable value is the sealed
 * Plan 67 broker; requests can select a named, schema-checked operation but
 * can never supply a browser, signer, command, rail, relay, report, or any
 * credentials. The source-build verifier is itself a sealed deployment
 * component and is invoked with immutable operation facts, rather than a
 * caller-provided command or callback.
 */
export class ProductionCertificationEdgeService {
  readonly #broker: ProductionSessionBroker;
  readonly #publication: ProductionPublicationCertification;

  constructor(input: Readonly<{ broker: unknown }>) {
    assertProductionSessionBroker(input.broker);
    this.#broker = input.broker;
    this.#publication = new ProductionPublicationCertification(input.broker.candidateSha256, input.broker.clients);
    services.add(this);
    Object.freeze(this);
  }

  async execute(raw: unknown): Promise<unknown> {
    const command = z.object({ operationId: OperationIdSchema, kind: EdgeKindSchema, payload: z.unknown() }).strict().parse(raw);
    const schema = CertificationEdgePayloadSchemas[command.kind];
    const payload = schema.parse(command.payload) as Record<string, unknown>;
    if (payload.candidateId !== this.#broker.candidateSha256) throw new Error("CERTIFICATION_EDGE_CANDIDATE_MISMATCH");

    switch (command.kind) {
      case "edge.security.browser": {
        const observed = await this.#broker.clients.edge.compatibleHost.runBrowser({ sealedArtifactSha256: payload.sealedArtifactSha256 as string, aggregateSha256: payload.aggregateSha256 as string });
        return observed;
      }
      case "edge.security.signer": {
        const observed = await this.#broker.clients.edge.signer.inspectSignerBoundary({ sealedArtifactSha256: payload.sealedArtifactSha256 as string, aggregateSha256: payload.aggregateSha256 as string });
        return observed;
      }
      case "edge.payment.contextvm": {
        // This is deliberately an original-operation query. It cannot create a
        // replacement session after a signed request has become ambiguous.
        const observed = await this.#broker.clients.contextvmCertification.observeOriginal({ operationId: command.operationId });
        if (observed.state !== "observed") throw new Error("CERTIFICATION_EDGE_CONTEXTVM_ORIGINAL_UNAVAILABLE");
        return this.#verify(command, payload, observed);
      }
      case "edge.payment.model": {
        const openAi = this.#broker.clients.edge.openAiResponses;
        if (!openAi) throw new Error("CERTIFICATION_EDGE_OPENAI_SUCCESSOR_HELD");
        // The Responses client only observes the durable original: unknown
        // response IDs never POST again, while known IDs use its fixed GET.
        return openAi.client.reconcileOriginal({ operationId: command.operationId });
      }
      case "edge.payment.cep8": {
        // The native providers own wallet/NWC material.  Counts are consulted
        // only as an additional invariant; the sealed verifier performs the
        // rail scenarios and rejects a claim unless its durable original IDs
        // prove exactly-one credit on each rail.
        const scenario = await this.#broker.clients.paymentScenarioContext.resolve({ candidateSha256: this.#broker.candidateSha256, operationId: command.operationId });
        const observed = Object.freeze({
          scenario,
          lightningVerifiedSettlements: this.#broker.clients.edge.cep8.verifiedSettlementCount(),
          cashuVerifiedSettlements: this.#broker.clients.edge.cashu.verifiedSettlementCount(),
        });
        return this.#verify(command, payload, observed);
      }
      case "edge.publication.direct.source": return this.#direct(CertificationEdgePayloadSchemas["edge.publication.direct.source"].parse(payload).reference).source();
      case "edge.publication.direct.submit": { const value = CertificationEdgePayloadSchemas[command.kind].parse(payload); return this.#direct(value.source.original).submit(value.source); }
      case "edge.publication.direct.reconcile": { const value = CertificationEdgePayloadSchemas[command.kind].parse(payload); return this.#direct(value.submitted.original).reconcile(value.submitted); }
      case "edge.publication.source": return this.#publication.source();
      case "edge.publication.submit": return this.#publication.submit(CertificationEdgePayloadSchemas[command.kind].parse(payload));
      case "edge.publication.reconcile": return this.#publication.reconcile(CertificationEdgePayloadSchemas[command.kind].parse(payload));
      default:
        return this.#verify(command, payload);
    }
  }

  /** Original control recovery never re-enters execute(), NIP-46, CLI upload
   * or event publication. Model recovery is the one non-publication exception:
   * it invokes the Responses client's original-ID GET-only reconciliation and
   * can never dispatch a replacement response. */
  async reconcile(raw: unknown): Promise<unknown> {
    const command = z.object({ operationId: OperationIdSchema, kind: EdgeKindSchema, payload: z.unknown() }).strict().parse(raw);
    const payload = CertificationEdgePayloadSchemas[command.kind].parse(command.payload) as Record<string, unknown>;
    if (payload.candidateId !== this.#broker.candidateSha256) throw new Error("CERTIFICATION_EDGE_CANDIDATE_MISMATCH");
    if (command.kind === "edge.payment.model") {
      const openAi = this.#broker.clients.edge.openAiResponses;
      if (!openAi) throw new Error("CERTIFICATION_EDGE_OPENAI_SUCCESSOR_HELD");
      return openAi.client.reconcileOriginal({ operationId: command.operationId });
    }
    if (command.kind === "edge.publication.direct.source") return this.#direct(CertificationEdgePayloadSchemas[command.kind].parse(payload).reference).source();
    if (command.kind === "edge.publication.direct.submit") { const value = CertificationEdgePayloadSchemas[command.kind].parse(payload); return this.#direct(value.source.original).observeSubmit(value.source); }
    if (command.kind === "edge.publication.direct.reconcile") { const value = CertificationEdgePayloadSchemas[command.kind].parse(payload); return this.#direct(value.submitted.original).reconcile(value.submitted); }
    if (command.kind === "edge.publication.source") return this.#publication.source();
    if (command.kind === "edge.publication.submit") return this.#publication.observeSubmit(CertificationEdgePayloadSchemas[command.kind].parse(payload));
    if (command.kind === "edge.publication.reconcile") return this.#publication.reconcile(CertificationEdgePayloadSchemas[command.kind].parse(payload));
    throw new Error("CERTIFICATION_EDGE_ORIGINAL_RECOVERY_UNAVAILABLE");
  }

  #direct(value: Readonly<{ principal: Readonly<{ pubkey: string }>; idempotencyKey: string }>) {
    const factory = this.#broker.clients.directPublication, expected = this.#broker.clients.directPublicationReference;
    if (!factory || !expected) throw new Error("CERTIFICATION_DIRECT_PUBLICATION_MATERIAL_REQUIRED");
    const parsed = DirectPublicationReferenceSchema.parse({ principal: value.principal, idempotencyKey: value.idempotencyKey });
    if (canonicalJson(parsed) !== canonicalJson(expected)) throw new Error("CERTIFICATION_DIRECT_PUBLICATION_REFERENCE_REQUIRED");
    return new ProductionDirectPublicationCertification(factory, expected, this.#broker.candidateSha256, this.#broker.topologySha256);
  }

  async #verify(command: Readonly<{ operationId: string; kind: CertificationEdgeKind }>, payload: Record<string, unknown>, observation?: unknown): Promise<unknown> {
    // The sealed verifier executes the fixed source-build/worker contract and
    // returns a transport-derived, schema-validated report. It receives no
    // shell text or report supplied by the private HTTP caller.
    return this.#broker.clients.sourceBuild.verify(Object.freeze({
      authority: "production-real" as const,
      operationId: command.operationId,
      kind: command.kind,
      candidateSha256: this.#broker.candidateSha256,
      topologySha256: this.#broker.topologySha256,
      payload: Object.freeze({ ...payload }),
      ...(observation === undefined ? {} : { observation }),
    }));
  }
}

export function assertProductionCertificationEdgeService(value: unknown): asserts value is ProductionCertificationEdgeService {
  if (!value || typeof value !== "object" || !services.has(value)) throw new Error("CERTIFICATION_EDGE_SERVICE_REQUIRED");
}
