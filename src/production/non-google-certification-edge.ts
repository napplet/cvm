import { z } from "zod";

import { CertificationEdgeKindSchema, CertificationEdgePayloadSchemas, type CertificationEdgeKind } from "./certification-edge-protocol";
import type { ProductionSourceBuildVerifier } from "../release/deployment/production-session-runtime";

const Digest = z.string().regex(/^[a-f0-9]{64}$/iu).transform(value => value.toLowerCase());
const OperationId = z.string().regex(/^[a-z][a-z0-9:_-]{2,127}$/u);

type OpenAiOriginalObserver = Readonly<{ reconcileOriginal(input: Readonly<{ operationId: string }>): Promise<unknown> }>;

export type NonGoogleCertificationEdgeBroker = Readonly<{
  realm: "non-google-edge-v1";
  candidateSha256: string;
  topologySha256: string;
  sourceBuild: ProductionSourceBuildVerifier;
  openAiResponses?: OpenAiOriginalObserver;
}>;

const brokers = new WeakSet<object>();
const services = new WeakSet<object>();

/** Seals the successor-only fixed edge ports. This broker deliberately carries
 * no Cloud Run client, ADC identity, or legacy control object. */
export function sealNonGoogleCertificationEdgeBroker(input: Readonly<{
  candidateSha256: string;
  topologySha256: string;
  sourceBuild: ProductionSourceBuildVerifier;
  openAiResponses?: OpenAiOriginalObserver;
}>): NonGoogleCertificationEdgeBroker {
  const candidateSha256 = Digest.parse(input.candidateSha256);
  const topologySha256 = Digest.parse(input.topologySha256);
  if (!input.sourceBuild || input.sourceBuild.authority !== "production-real" || typeof input.sourceBuild.verify !== "function") throw new Error("NON_GOOGLE_CERTIFICATION_EDGE_SOURCE_BUILD_REQUIRED");
  if (input.openAiResponses !== undefined && typeof input.openAiResponses.reconcileOriginal !== "function") throw new Error("NON_GOOGLE_CERTIFICATION_EDGE_MODEL_PORT_REQUIRED");
  const broker = Object.freeze({ realm: "non-google-edge-v1" as const, candidateSha256, topologySha256, sourceBuild: input.sourceBuild, ...(input.openAiResponses === undefined ? {} : { openAiResponses: input.openAiResponses }) });
  brokers.add(broker);
  return broker;
}

export function assertNonGoogleCertificationEdgeBroker(value: unknown): asserts value is NonGoogleCertificationEdgeBroker {
  if (!value || typeof value !== "object" || !brokers.has(value)) throw new Error("NON_GOOGLE_CERTIFICATION_EDGE_BROKER_REQUIRED");
}

/** Separately branded native service. Construction is inert and its module
 * imports no historical Cloud Run/ADC assembly. */
export class NonGoogleCertificationEdgeService {
  readonly #broker: NonGoogleCertificationEdgeBroker;

  constructor(input: Readonly<{ broker: unknown }>) {
    assertNonGoogleCertificationEdgeBroker(input.broker);
    this.#broker = input.broker;
    services.add(this);
    Object.freeze(this);
  }

  async execute(raw: unknown): Promise<unknown> {
    const command = z.object({ operationId: OperationId, kind: CertificationEdgeKindSchema, payload: z.unknown() }).strict().parse(raw);
    return this.#run(command);
  }

  /** Only a durable model original is eligible for successor reconciliation.
   * It cannot create a replacement request. */
  async reconcile(raw: unknown): Promise<unknown> {
    const command = z.object({ operationId: OperationId, kind: CertificationEdgeKindSchema, payload: z.unknown() }).strict().parse(raw);
    const payload = CertificationEdgePayloadSchemas[command.kind].parse(command.payload) as Record<string, unknown>;
    if (payload.candidateId !== this.#broker.candidateSha256) throw new Error("CERTIFICATION_EDGE_CANDIDATE_MISMATCH");
    if (command.kind !== "edge.payment.model") throw new Error("CERTIFICATION_EDGE_ORIGINAL_RECOVERY_UNAVAILABLE");
    const model = this.#broker.openAiResponses;
    if (!model) throw new Error("CERTIFICATION_EDGE_OPENAI_SUCCESSOR_HELD");
    return model.reconcileOriginal({ operationId: command.operationId });
  }

  async #run(command: Readonly<{ operationId: string; kind: CertificationEdgeKind; payload: unknown }>): Promise<unknown> {
    const payload = CertificationEdgePayloadSchemas[command.kind].parse(command.payload) as Record<string, unknown>;
    if (payload.candidateId !== this.#broker.candidateSha256) throw new Error("CERTIFICATION_EDGE_CANDIDATE_MISMATCH");
    if (command.kind === "edge.payment.model") {
      const model = this.#broker.openAiResponses;
      if (!model) throw new Error("CERTIFICATION_EDGE_OPENAI_SUCCESSOR_HELD");
      return model.reconcileOriginal({ operationId: command.operationId });
    }
    return this.#broker.sourceBuild.verify(Object.freeze({ authority: "production-real" as const, operationId: command.operationId, kind: command.kind, candidateSha256: this.#broker.candidateSha256, topologySha256: this.#broker.topologySha256, payload: Object.freeze({ ...payload }) }));
  }
}

export function assertNonGoogleCertificationEdgeService(value: unknown): asserts value is NonGoogleCertificationEdgeService {
  if (!value || typeof value !== "object" || !services.has(value)) throw new Error("NON_GOOGLE_CERTIFICATION_EDGE_SERVICE_REQUIRED");
}
