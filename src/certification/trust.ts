/**
 * The promotion process never treats a candidate-provided digest as an
 * authority decision. Implementations are operator/protected-certifier
 * adapters that resolve and authenticate material from their protected store.
 * Returning anything other than `true` is a verification failure.
 */
export interface ReleaseCertificationTrustRoot {
  verifyManifest(manifest: unknown): Promise<boolean>;
  verifyObservation(observation: unknown): Promise<boolean>;
  verifyReproducibilityRecord(record: unknown): Promise<boolean>;
  verifySupplyChainRecord(record: unknown): Promise<boolean>;
  verifySourceMeasurement(measurement: unknown): Promise<boolean>;
}
