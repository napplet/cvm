import { z } from "zod";

/** Project-owned control/collector allocation. Candidate source and the native
 * request hash bind these facts; mounts cannot raise them independently. This
 * is a desired resource profile, not an asserted vendor currency spend cap. */
export const PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE = Object.freeze({
  version: 1,
  minimumInstances: 3,
  maximumInstances: 3,
  cpu: 1,
  memoryMiB: 512,
  cpuIdle: false,
  startupCpuBoost: false,
});

export const PRODUCTION_CLOUD_RUN_SERVICE_SCALING = Object.freeze({
  minInstanceCount: PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.minimumInstances,
  maxInstanceCount: PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.maximumInstances,
  scalingMode: "AUTOMATIC",
});
export const PRODUCTION_CLOUD_RUN_RESOURCES = Object.freeze({
  limits: Object.freeze({ cpu: String(PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.cpu), memory: `${PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.memoryMiB}Mi` }),
  cpuIdle: PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.cpuIdle,
  startupCpuBoost: PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.startupCpuBoost,
});

export const CloudRunServiceScalingSchema = z.object({
  minInstanceCount: z.literal(PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.minimumInstances), maxInstanceCount: z.literal(PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.maximumInstances),
  scalingMode: z.literal("AUTOMATIC").default("AUTOMATIC"),
  manualInstanceCount: z.literal(0).optional(),
}).strict();
export const CloudRunRevisionScalingSchema = z.object({ minInstanceCount: z.literal(PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.minimumInstances), maxInstanceCount: z.literal(PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.maximumInstances) }).strict();
export const CloudRunResourceRequirementsSchema = z.object({
  limits: z.object({ cpu: z.literal(PRODUCTION_CLOUD_RUN_RESOURCES.limits.cpu), memory: z.literal(PRODUCTION_CLOUD_RUN_RESOURCES.limits.memory) }).strict(),
  // Proto JSON can omit false. With ResourceRequirements present, these
  // omitted boolean fields have the documented false semantics.
  cpuIdle: z.literal(PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.cpuIdle).default(PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.cpuIdle),
  startupCpuBoost: z.literal(PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.startupCpuBoost).default(PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.startupCpuBoost),
}).strict();

/** The existing certification window, shared by admission authorization and
 * desired allocation quantities. Cleanup/actual billing still require proof. */
export const CERTIFICATION_RUN_DURATION_MS = 15 * 60 * 1000;
export const CLOUD_RUN_CERTIFICATION_CPU_SECONDS_NANOS = BigInt(PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.maximumInstances * PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.cpu * CERTIFICATION_RUN_DURATION_MS) * 1_000_000n;
export const CLOUD_RUN_CERTIFICATION_MEMORY_GIB_SECONDS_NANOS = BigInt(PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.maximumInstances * PRODUCTION_CLOUD_RUN_RESOURCE_PROFILE.memoryMiB * CERTIFICATION_RUN_DURATION_MS) * 1_000_000n / 1024n;
