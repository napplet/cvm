import { z } from "zod";

import type { ProductionSourceBuildVerifier } from "../release/deployment/production-session-runtime";
import type { ProductionConfig } from "./config";
import type { MountedProductionSessionRecord } from "./mounted-session-record";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u).transform(value => value.toLowerCase());
const Kind = z.enum([
  "edge.security.build", "edge.security.hostile", "edge.security.browser", "edge.security.signer",
  "edge.supply.primary", "edge.supply.secondary", "edge.supply.attestation",
  "edge.payment.contextvm", "edge.payment.cep8", "edge.payment.model",
  "edge.publication.source", "edge.publication.submit", "edge.publication.reconcile",
]);
const Request = z.object({
  authority: z.literal("production-real"), operationId: z.string().regex(/^[a-z][a-z0-9:_-]{2,127}$/u),
  kind: Kind, candidateSha256: Digest, topologySha256: Digest,
  payload: z.record(z.string(), z.unknown()), observation: z.unknown().optional(),
}).strict();

/**
 * Bounded verifier for the source-build edge.  A release-certifier
 * materialization proves only that the controller code was pinned; it does
 * not run a napplet build, `pnpm verify`, or Chromium conformance.  Until an
 * immutable, worker-produced source-build observation is wired here, this
 * refuses to promote the preapproval hashes to a passed result.
 *
 * Other edge kinds must provide an actual provider observation from their own
 * concrete branch; this intentionally refuses to turn a missing observation
 * into a success or recurse through private HTTP control.
 */
export function createMountedProductionSourceBuildVerifier(input: Readonly<{
  config: ProductionConfig;
  record: MountedProductionSessionRecord;
  authorization: Readonly<{ authorizationRequestSha256: string; authorizationReceiptSha256: string }>;
}>): ProductionSourceBuildVerifier {
  const execution = input.record.execution;
  const build = execution.protected.sourceBuild;
  const materialization = execution.materialization;
  if (build.candidateSha256 !== input.config.candidateSha256 || build.topologySha256 !== input.config.topologySha256
    || build.image !== input.config.worker.image || build.sourceSha256 !== materialization.source.sourceSha256
    || input.record.workerCandidate.sourceSha256 !== build.sourceSha256) {
    throw new Error("PRODUCTION_SOURCE_BUILD_BINDING_REQUIRED");
  }
  return Object.freeze({
    authority: "production-real",
    async verify(raw: unknown): Promise<unknown> {
      const request = Request.parse(raw);
      if (request.candidateSha256 !== input.config.candidateSha256 || request.topologySha256 !== input.config.topologySha256) {
        throw new Error("PRODUCTION_SOURCE_BUILD_SCOPE_REQUIRED");
      }
      if (request.kind !== "edge.security.build") {
        if (request.observation === undefined) throw new Error("PRODUCTION_EDGE_ORIGINAL_OBSERVATION_REQUIRED");
        return request.observation;
      }
      const payload = z.object({ candidateId: Digest, image: z.string().min(1).max(1_024) }).strict().parse(request.payload);
      if (payload.candidateId !== input.config.candidateSha256 || payload.image !== build.image) {
        throw new Error("PRODUCTION_SOURCE_BUILD_PAYLOAD_REQUIRED");
      }
      // The mounted record is an authorization/preapproval binding, not an
      // execution receipt. Never substitute these four stored hashes for
      // worker-produced bytes and reports.
      void materialization;
      throw new Error("PRODUCTION_SOURCE_BUILD_EXECUTION_REQUIRED");
    },
  });
}
