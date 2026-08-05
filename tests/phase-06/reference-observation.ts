export type Phase06ReferenceObservation = Readonly<{
  id: string;
  status: string;
  effects: string;
  value: string;
}>;

/** Emits facts only after the enclosing scenario has asserted them. */
export function reportPhase06Observation(observation: Phase06ReferenceObservation): void {
  if (process.env.PHASE06_REFERENCE_OBSERVATIONS === "1") console.log(`PHASE06_OBSERVATION:${JSON.stringify(observation)}`);
}
