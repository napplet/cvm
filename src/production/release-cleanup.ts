import type { ReleaseProviderId } from "../release/contracts";
import type { ReleaseProviderPort } from "../release/providers";
import type { ReleaseFinalizationCleanupPort } from "../release/finalize";

type Effect = Readonly<{ provider: ReleaseProviderId; providerOperationId: string; resourceIdentitySha256: string }>;

/** Finalizer cleanup is bound to the exact owned resource. An invocation that
 * returned pending/blocked is not completion, and the generic resource's
 * apply/observe status is not proof of a cleanup operation's outcome. */
export function createMountedReleaseCleanup(input: Readonly<{
  effects: readonly Effect[];
  providers: Readonly<Record<ReleaseProviderId, Readonly<{ port: ReleaseProviderPort }>>>;
}>): ReleaseFinalizationCleanupPort {
  const effects = new Map(input.effects.map(effect => [effect.providerOperationId, effect]));
  if (effects.size !== input.effects.length) throw new Error("PRODUCTION_MOUNTED_CLEANUP_DUPLICATE_ORIGINAL");
  const resolve = (effect: Parameters<ReleaseFinalizationCleanupPort["cleanup"]>[0]) => {
    const original = effects.get(effect.providerOperationId);
    if (!original || original.resourceIdentitySha256 !== effect.resourceIdentitySha256) throw new Error("PRODUCTION_MOUNTED_CLEANUP_ORIGINAL_REQUIRED");
    return input.providers[original.provider].port;
  };
  return Object.freeze({
    async cleanup(effect) {
      const provider = resolve(effect);
      try {
        const result = await provider.cleanup({ operationId: effect.providerOperationId, resourceIdentitySha256: effect.resourceIdentitySha256 });
        return result.status === "cleaned" ? "cleaned" as const : "unknown" as const;
      } catch { return "unknown" as const; }
    },
    async observe(effect) {
      const provider = resolve(effect);
      // A generic completed result proves an applied resource still exists.
      // Even missing is insufficient without a dedicated original-cleanup
      // observation (it can mean an unknown local operation). Keep recovery
      // blocked until that provider-specific proof is available.
      try { await provider.observe({ operationId: effect.providerOperationId }); } catch { /* unresolved */ }
      return "unknown" as const;
    },
  });
}
