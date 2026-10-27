import { createHash } from "node:crypto";
import { z } from "zod";

import { SignedOwnerManifestEventSchema, type PublicationObservation, type SealedArtifactIdentity } from "../../publication/contracts.js";
import type { StructuredSourceEffect } from "../../publication/napplet-cli-adapter.js";
import { validateAuthorizationReceipt, validateAuthorizationRequest, type ReleaseAuthorizationReceipt, type ReleaseAuthorizationRequest } from "../authorization.js";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const PubkeySchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const RelaySchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "wss:" || (url.protocol === "ws:" && ["127.0.0.1", "::1", "localhost"].includes(url.hostname));
}, "RELAY_WSS_REQUIRED");
const OperationIdSchema = z.string().min(1).max(300);
const NostrEventSchema = z.object({
  id: DigestSchema, pubkey: PubkeySchema, created_at: z.number().int().nonnegative(), kind: z.number().int().nonnegative(),
  tags: z.array(z.array(z.string().max(4_096)).min(1).max(16)).max(128), content: z.string().max(64_000), sig: z.string().regex(/^[a-f0-9]{128}$/iu),
}).strict();
type NostrEvent = z.infer<typeof NostrEventSchema>;

const RelayConfigSchema = z.object({
  candidateSha256: DigestSchema,
  topologySha256: DigestSchema,
  effectPlanSha256: DigestSchema,
  ownerAccountScopeSha256: DigestSchema,
  ownerProjectScopeSha256: DigestSchema,
  attestationAccountScopeSha256: DigestSchema,
  attestationProjectScopeSha256: DigestSchema,
  intentId: z.string().min(1).max(256),
  sealedArtifactSha256: DigestSchema,
  aggregateSha256: DigestSchema,
  relaySetReference: z.string().min(1).max(256),
  relaySetSha256: DigestSchema,
  relays: z.array(RelaySchema).min(1).max(16),
  ownerEvent: SignedOwnerManifestEventSchema,
  attestationEvent: NostrEventSchema,
  ownerSignerPubkey: PubkeySchema,
  attestationSignerPubkey: PubkeySchema,
}).strict();
type RelayConfig = z.infer<typeof RelayConfigSchema>;

type RelayObservation = Readonly<{
  status: "missing" | "complete" | "pending" | "unknown" | "blocked";
  operationId?: string;
  eventId?: string;
  relaySetReference?: string;
  relayObservation?: string;
}>;

/** Official relay client and durability are injected by protected execution only. */
export type NostrRelayPort = Readonly<{
  persistSignedEvent(input: Readonly<{
    operationId: string;
    eventId: string;
    eventBytes: Uint8Array;
    eventBytesSha256: string;
    candidateSha256: string;
    sealedArtifactSha256: string;
    aggregateSha256: string;
    relaySetReference: string;
    relaySetSha256: string;
    authorizationRequestSha256: string;
    authorizationReceiptSha256: string;
  }>): Promise<void>;
  observeOriginalEvent(input: Readonly<{ operationId: string; eventId: string; relaySetReference: string }>): Promise<unknown>;
  publishSignedEvent(input: Readonly<{ operationId: string; eventId: string; eventBytes: Uint8Array; relays: readonly string[] }>): Promise<void>;
}>;

function canonicalSignedEventBytes(event: NostrEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags, content: event.content, sig: event.sig }));
}

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function exactSet(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value) => right.includes(value)) && new Set(left).size === left.length; }

function parseObservation(value: unknown): RelayObservation {
  const parsed = z.object({
    status: z.enum(["missing", "complete", "pending", "unknown", "blocked"]), operationId: OperationIdSchema.optional(), eventId: DigestSchema.optional(),
    relaySetReference: z.string().min(1).max(256).optional(), relayObservation: z.string().min(1).max(512).optional(),
  }).strict().safeParse(value);
  if (!parsed.success) throw new Error("NOSTR_RELAY_OBSERVATION_INVALID");
  return parsed.data;
}

async function authorize(input: Readonly<{ request: unknown; receipt: unknown; nowMs: number; kind: "owner" | "attestation" }>, config: RelayConfig): Promise<Readonly<{ request: ReleaseAuthorizationRequest; receipt: ReleaseAuthorizationReceipt }>> {
  try {
    const request = await validateAuthorizationRequest(input.request);
    const receipt = await validateAuthorizationReceipt({ request, receipt: input.receipt, nowMs: input.nowMs });
    const provider = input.kind === "owner" ? "owner_relay" : "attestation_relay";
    const effectId = input.kind === "owner" ? "owner-relay" : "attestation-relay";
    const expectedAccountScope = input.kind === "owner" ? config.ownerAccountScopeSha256 : config.attestationAccountScopeSha256;
    const expectedProjectScope = input.kind === "owner" ? config.ownerProjectScopeSha256 : config.attestationProjectScopeSha256;
    const effects = request.orderedEffects.filter((effect) => effect.provider === provider);
    const scopes = request.providerScopes.filter((scope) => scope.provider === provider);
    if (request.candidateSha256 !== config.candidateSha256 || request.topologySha256 !== config.topologySha256 || request.effectPlanSha256 !== config.effectPlanSha256
      || receipt.candidateSha256 !== config.candidateSha256 || receipt.topologySha256 !== config.topologySha256 || receipt.effectPlanSha256 !== config.effectPlanSha256
      || effects.length !== 1 || effects[0]?.id !== effectId || effects[0]?.operation !== "verify_integration"
      || scopes.length !== 1 || scopes[0]?.accountScopeSha256 !== expectedAccountScope || scopes[0]?.projectScopeSha256 !== expectedProjectScope) throw new Error("scope");
    return Object.freeze({ request, receipt });
  } catch {
    throw new Error("NOSTR_RELAY_AUTHORIZATION_INVALID");
  }
}

function expected(config: RelayConfig, kind: "owner" | "attestation"): Readonly<{ operationId: string; event: NostrEvent }> {
  const operationId = `${kind === "owner" ? "owner_manifest" : "attestation"}:${config.intentId}`;
  return Object.freeze({ operationId, event: kind === "owner" ? NostrEventSchema.parse(config.ownerEvent) : config.attestationEvent });
}

function validateEvent(config: RelayConfig, kind: "owner" | "attestation", operationId: unknown, event: unknown, relays: unknown): Readonly<{ operationId: string; event: NostrEvent; relays: readonly string[] }> {
  try {
    const operation = OperationIdSchema.parse(operationId);
    const parsedEvent = NostrEventSchema.parse(event);
    const parsedRelays = z.array(RelaySchema).min(1).max(16).parse(relays);
    const expectedValue = expected(config, kind);
    const expectedSigner = kind === "owner" ? config.ownerSignerPubkey : config.attestationSignerPubkey;
    if (operation !== expectedValue.operationId || parsedEvent.pubkey !== expectedSigner || JSON.stringify(parsedEvent) !== JSON.stringify(expectedValue.event) || !exactSet(parsedRelays, config.relays)) throw new Error("mismatch");
    return Object.freeze({ operationId: operation, event: parsedEvent, relays: Object.freeze([...parsedRelays]) });
  } catch {
    throw new Error("NOSTR_RELAY_EVENT_INVALID");
  }
}

function complete(observation: RelayObservation, operationId: string, eventId: string, config: RelayConfig): PublicationObservation | undefined {
  if (observation.status !== "complete") return undefined;
  if (observation.operationId !== operationId || observation.eventId !== eventId || observation.relaySetReference !== config.relaySetReference || !observation.relayObservation) throw new Error("NOSTR_RELAY_OBSERVATION_MISMATCH");
  return Object.freeze({ operationId, state: "completed", observationId: `observation:${operationId}:${eventId}`, relayObservation: observation.relayObservation });
}

export type NostrRelayPublicationAdapter = Readonly<{
  publishOwnerManifest(input: Readonly<{ operationId: string; event: unknown; relays: readonly string[] }>): Promise<PublicationObservation>;
  publishAttestation(input: Readonly<{ operationId: string; event: unknown; relays: readonly string[] }>): Promise<PublicationObservation>;
  reconcileOriginalEvent(input: Readonly<{ operationId: string }>): Promise<PublicationObservation>;
  asPromotedCliSource(): Readonly<{ publishOriginalEvent(input: Readonly<{ operationId: string; event: unknown; relays: readonly string[] }>): Promise<StructuredSourceEffect>; reconcileOriginalEvent(input: Readonly<{ operationId: string }>): Promise<StructuredSourceEffect> }>;
  attestationPort: Readonly<{ publish(input: Readonly<{ operationId: string; artifact: SealedArtifactIdentity; ownerEventId: string }>): Promise<PublicationObservation>; observe(input: Readonly<{ operationId: string }>): Promise<PublicationObservation> }>;
}>;

/** Persist-before-publish, receipt-gated Nostr relay adapter with original-ID-only recovery. */
export function createNostrRelayPublicationAdapter(input: Readonly<{ config: unknown; request: unknown; receipt: unknown; port: NostrRelayPort; now?: () => number }>): NostrRelayPublicationAdapter {
  const config = Object.freeze(RelayConfigSchema.parse(input.config));
  const now = input.now ?? Date.now;

  async function reconcile(kind: "owner" | "attestation", raw: Readonly<{ operationId: string }>): Promise<PublicationObservation> {
    const expectedValue = expected(config, kind);
    if (OperationIdSchema.parse(raw.operationId) !== expectedValue.operationId) throw new Error("NOSTR_RELAY_EVENT_INVALID");
    await authorize({ request: input.request, receipt: input.receipt, nowMs: now(), kind }, config);
    const observation = parseObservation(await input.port.observeOriginalEvent({ operationId: expectedValue.operationId, eventId: expectedValue.event.id, relaySetReference: config.relaySetReference }));
    const prior = complete(observation, expectedValue.operationId, expectedValue.event.id, config);
    if (prior) return prior;
    return Object.freeze({ operationId: expectedValue.operationId, state: observation.status === "blocked" ? "failed" : "unknown", observationId: `observation:${expectedValue.operationId}:pending` });
  }

  async function publish(kind: "owner" | "attestation", raw: Readonly<{ operationId: string; event: unknown; relays: readonly string[] }>): Promise<PublicationObservation> {
    const value = validateEvent(config, kind, raw.operationId, raw.event, raw.relays);
    const authorized = await authorize({ request: input.request, receipt: input.receipt, nowMs: now(), kind }, config);
    const eventBytes = canonicalSignedEventBytes(value.event);
    await input.port.persistSignedEvent({
      operationId: value.operationId, eventId: value.event.id, eventBytes, eventBytesSha256: digest(eventBytes), candidateSha256: config.candidateSha256,
      sealedArtifactSha256: config.sealedArtifactSha256, aggregateSha256: config.aggregateSha256, relaySetReference: config.relaySetReference,
      relaySetSha256: config.relaySetSha256, authorizationRequestSha256: authorized.request.authorizationRequestSha256, authorizationReceiptSha256: authorized.receipt.authorizationReceiptSha256,
    });
    const existing = parseObservation(await input.port.observeOriginalEvent({ operationId: value.operationId, eventId: value.event.id, relaySetReference: config.relaySetReference }));
    const prior = complete(existing, value.operationId, value.event.id, config);
    if (prior) return prior;
    if (existing.status !== "missing") return Object.freeze({ operationId: value.operationId, state: existing.status === "blocked" ? "failed" : "unknown", observationId: `observation:${value.operationId}:pending` });
    // The receipt is revalidated after all persistence/reconciliation work and immediately before relay publication.
    await authorize({ request: input.request, receipt: input.receipt, nowMs: now(), kind }, config);
    try {
      await input.port.publishSignedEvent({ operationId: value.operationId, eventId: value.event.id, eventBytes, relays: value.relays });
    } catch {
      return reconcile(kind, { operationId: value.operationId });
    }
    return reconcile(kind, { operationId: value.operationId });
  }

  const publishOwnerManifest = (value: Readonly<{ operationId: string; event: unknown; relays: readonly string[] }>) => publish("owner", value);
  const publishAttestation = (value: Readonly<{ operationId: string; event: unknown; relays: readonly string[] }>) => publish("attestation", value);
  return Object.freeze({
    publishOwnerManifest,
    publishAttestation,
    reconcileOriginalEvent: async ({ operationId }) => operationId.startsWith("owner_manifest:") ? reconcile("owner", { operationId }) : reconcile("attestation", { operationId }),
    asPromotedCliSource: () => Object.freeze({
      async publishOriginalEvent(value) {
        const result = await publishOwnerManifest(value);
        return Object.freeze({ operationId: result.operationId, state: result.state === "completed" ? "complete" : result.state === "failed" ? "failed" : "unknown", relayObservation: result.relayObservation });
      },
      async reconcileOriginalEvent({ operationId }) {
        const result = await (operationId.startsWith("owner_manifest:") ? reconcile("owner", { operationId }) : reconcile("attestation", { operationId }));
        return Object.freeze({ operationId: result.operationId, state: result.state === "completed" ? "complete" : result.state === "failed" ? "failed" : "unknown", relayObservation: result.relayObservation });
      },
    }),
    attestationPort: Object.freeze({
      async publish(value) {
        if (value.artifact.sealedObjectSha256 !== config.sealedArtifactSha256 || value.artifact.aggregateSha256 !== config.aggregateSha256 || value.ownerEventId !== config.ownerEvent.id) throw new Error("NOSTR_RELAY_EVENT_INVALID");
        return publishAttestation({ operationId: value.operationId, event: config.attestationEvent, relays: config.relays });
      },
      observe: ({ operationId }) => reconcile("attestation", { operationId }),
    }),
  });
}
