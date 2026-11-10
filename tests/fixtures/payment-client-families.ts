/** Opaque ports for registry identity tests. These never verify or settle payments. */
export function createPaymentClientFamiliesFixture(_input: unknown) {
  const port = () => Object.freeze({
    discovery(): never { throw new Error("PAYMENT_FIXTURE_DISCOVERY_FORBIDDEN"); },
    async reconcileOriginal(_input: unknown): Promise<never> { throw new Error("PAYMENT_FIXTURE_SETTLEMENT_FORBIDDEN"); },
  });
  return Object.freeze({ nwc: port(), cashu: port() });
}
