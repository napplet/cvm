import { z } from "zod";

import type { ReleaseProviderId, ReleaseProviderPort as ControllerReleaseProviderPort, ReleaseProviderRegistry as ControllerReleaseProviderRegistry } from "./contracts";
import { ReleaseProviderIdSchema } from "./contracts";
import { createReleaseProviderRegistry, type ReleaseProviderPort, type ReleaseProviderRegistry } from "./providers";

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu).transform((value) => value.toLowerCase());
const ReferenceSchema = z.object({
  reference: z.string().regex(/^[a-z][a-z0-9:./_-]{2,255}$/iu),
  referenceSha256: DigestSchema,
}).strict();

export const RELEASE_PRODUCTION_PROVIDER_IDS = Object.freeze(ReleaseProviderIdSchema.options) as readonly ReleaseProviderId[];

const RegistryInputSchema = z.object({
  candidateSha256: DigestSchema,
  providerReferences: z.record(ReleaseProviderIdSchema, ReferenceSchema).optional(),
}).strict();

export type NativeReleaseProviderRegistryInput = Readonly<{
  /** Candidate-bound references only. Sessions and provider clients are injected handles. */
  candidateSha256: string;
  providerReferences?: Partial<Record<ReleaseProviderId, Readonly<{ reference: string; referenceSha256: string }>>>;
  providers?: Partial<Record<ReleaseProviderId, ReleaseProviderPort>>;
  now?: () => number;
}>;

function blockedPort(): ReleaseProviderPort {
  const blocked = async () => { throw new Error("RELEASE_PROVIDER_CAPABILITY_BLOCKED"); };
  return Object.freeze({
    discoverCapabilities: async () => ({ capability: "unavailable" as const }),
    discoverAuthentication: async () => ({ authentication: "unavailable" as const }),
    plan: blocked,
    apply: blocked,
    observe: blocked,
    cleanup: blocked,
  }) as ReleaseProviderPort;
}

/**
 * Builds all release provider families from injected, schema-validated handles.
 * It does not create a client, contact a provider, inspect ambient credentials,
 * or retain raw credentials: absence becomes a finite capability-blocked port.
 */
export function createNativeReleaseProviderRegistry(input: NativeReleaseProviderRegistryInput): ReleaseProviderRegistry {
  const parsed = RegistryInputSchema.parse({
    candidateSha256: input.candidateSha256,
    ...(input.providerReferences ? { providerReferences: input.providerReferences } : {}),
  });
  void parsed.candidateSha256;
  const ports = Object.fromEntries(RELEASE_PRODUCTION_PROVIDER_IDS.map((provider) => [provider, input.providers?.[provider] ?? blockedPort()])) as Record<ReleaseProviderId, ReleaseProviderPort>;
  return createReleaseProviderRegistry({ ports, now: input.now });
}

/**
 * The admission controller sees only provider-neutral discovery facts. This
 * bridge deliberately delegates discovery to the same authorized registry;
 * it has no alternate evaluator, fixture fallback, or credential surface.
 */
export function createReleaseControllerProviderRegistry(native: ReleaseProviderRegistry): ControllerReleaseProviderRegistry {
  return Object.fromEntries(RELEASE_PRODUCTION_PROVIDER_IDS.map((provider) => [provider, Object.freeze({
    async discover() {
      const result = await native.discover(provider);
      const { version: _version, provider: _provider, ...observation } = result;
      return observation;
    },
  } satisfies ControllerReleaseProviderPort)])) as ControllerReleaseProviderRegistry;
}
