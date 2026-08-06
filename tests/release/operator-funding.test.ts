import { expect, test } from "bun:test";
import { createOperatorFundingPrerequisiteController } from "../../src/release/deployment/operator-funding";

const digest = (letter: string) => letter.repeat(64);
const nowMs = 10_000;

const rail = (kind: "nwc_lightning" | "cashu", reference: string) => ({
  rail: kind,
  secretReference: reference,
  capabilitySha256: digest(kind === "cashu" ? "c" : "a"),
  accountScopeSha256: digest(kind === "cashu" ? "d" : "b"),
  expiresAtMs: nowMs + 60_000,
  status: "ready" as const,
});

test("requires separate opaque ready references for NWC Lightning and funded Cashu without opening a secret surface", async () => {
  let opens = 0;
  const controller = createOperatorFundingPrerequisiteController({ now: () => nowMs, onSecretSurfaceOpen: () => { opens += 1; } });
  expect(await controller.readiness()).toMatchObject({ status: "pending", rails: [] });
  await controller.capture(rail("nwc_lightning", "os-secret-ref:release-nwc-01"));
  expect(await controller.readiness()).toMatchObject({ status: "pending", rails: [{ rail: "nwc_lightning", secretReference: "os-secret-ref:release-nwc-01" }] });
  await controller.capture(rail("cashu", "os-secret-ref:release-cashu-01"));
  const ready = await controller.readiness();
  expect(ready).toMatchObject({ status: "ready", rails: [
    { rail: "nwc_lightning", secretReference: "os-secret-ref:release-nwc-01" },
    { rail: "cashu", secretReference: "os-secret-ref:release-cashu-01" },
  ] });
  expect(ready.readinessSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(opens).toBe(0);
});

test("rejects secret-shaped inputs and invalidates ready funding when a reference changes, expires, or is revoked", async () => {
  const controller = createOperatorFundingPrerequisiteController({ now: () => nowMs });
  await expect(controller.capture({ ...rail("nwc_lightning", "nwc://wallet-secret"), secretReference: "nwc://wallet-secret" })).rejects.toThrow("OPERATOR_FUNDING_REFERENCE_INVALID");
  await controller.capture(rail("nwc_lightning", "os-secret-ref:release-nwc-01"));
  await controller.capture(rail("cashu", "os-secret-ref:release-cashu-01"));
  const original = await controller.readiness();
  await controller.capture(rail("cashu", "os-secret-ref:release-cashu-02"));
  const changed = await controller.readiness();
  expect(changed.status).toBe("invalid");
  expect(changed.readinessSha256).not.toBe(original.readinessSha256);
  expect(changed.rails.some((item) => item.status === "revoked")).toBeTrue();
});
