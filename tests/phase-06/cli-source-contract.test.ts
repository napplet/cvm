import { describe, expect, test } from "bun:test";
import fixture from "../fixtures/phase-06-cli-source-contract.json" with { type: "json" };
import {
  NAPPLET_CLI_LINUX_SHA256,
  NAPPLET_CLI_SOURCE_COMMIT,
  probePromotedCliPreSignedRoute,
  validatedAvailablePromotedCliSourceContract,
  SOURCE_BUILT_CLI_SNAPSHOT,
  SOURCE_BUILT_CLI_IDENTITY,
} from "../../src/publication/napplet-cli-source-contract.js";
import { PromotedNappletCliAdapter } from "../../src/publication/napplet-cli-adapter";
import { reportPhase06Observation } from "./reference-observation.js";

describe("promoted napplet CLI exact-source contract", () => {
  test("keeps source-built and historical provenance separate at the publication boundary", async () => {
    const built = probePromotedCliPreSignedRoute(SOURCE_BUILT_CLI_SNAPSHOT);
    expect(built).toMatchObject({ status: "available", identity: SOURCE_BUILT_CLI_IDENTITY, liveExecution: "not_observed" });
    expect(validatedAvailablePromotedCliSourceContract(built)).toBeDefined();
    expect(probePromotedCliPreSignedRoute({ ...SOURCE_BUILT_CLI_SNAPSHOT, sourceFiles: fixture.sourceFiles }).status).toBe("publication_unavailable");
    expect(validatedAvailablePromotedCliSourceContract({ ...built, sourceFiles: fixture.sourceFiles })).toBeUndefined();
    const source = { async uploadFilesToServers() { throw new Error("NO_EFFECT"); }, async publishEventWithSimplePool() { throw new Error("NO_EFFECT"); } };
    expect(new PromotedNappletCliAdapter({ contract: built, source }).identity).toEqual(SOURCE_BUILT_CLI_IDENTITY);
    expect(() => new PromotedNappletCliAdapter({ contract: built, source, identity: fixture.identity as any })).toThrow("PROMOTED_CLI_IDENTITY_MISMATCH");
    const mutable = structuredClone(built);
    const adapter = new PromotedNappletCliAdapter({ contract: mutable, source });
    Object.assign(mutable, probePromotedCliPreSignedRoute(fixture));
    expect(await adapter.deployPreSignedNamed({ operationId: "no-effect" } as any)).toMatchObject({ state: "publication_unavailable" });
  });
  test("accepts only the promoted commit, Linux asset, structured pre-signed route, and closed unsafe inventory", () => {
    expect(NAPPLET_CLI_SOURCE_COMMIT).toBe("1a38b9150f3a3da148091c11bce4d0365f7298e5");
    expect(NAPPLET_CLI_LINUX_SHA256).toBe("46685f2e4df516b5b2e7e2e133480c90e5c85dbd36d05c6e95f4eee6af33ec5e");
    expect(probePromotedCliPreSignedRoute(fixture)).toEqual(expect.objectContaining({
      status: "available",
      liveExecution: "not_observed",
    }));
  });

  test("retains complete exact provenance when the validated result crosses another trust boundary", () => {
    const available = probePromotedCliPreSignedRoute(fixture);
    expect(available).toMatchObject({
      status: "available",
      identity: { version: "0.5.2", sourceCommit: NAPPLET_CLI_SOURCE_COMMIT, linuxSha256: NAPPLET_CLI_LINUX_SHA256 },
      sourceFiles: fixture.sourceFiles,
      surface: { requiredExports: fixture.requiredExports, rejectedRoutes: fixture.rejectedRoutes },
    });
    expect(validatedAvailablePromotedCliSourceContract(available)).toBeDefined();

    for (const forgedOrMutated of [
      { status: "available", liveExecution: "not_observed" },
      { ...available, identity: { ...available.identity, sourceCommit: "0".repeat(40) } },
      { ...available, sourceFiles: { ...available.sourceFiles, "cli.ts": "0".repeat(64) } },
      { ...available, surface: { ...available.surface, requiredExports: available.surface.requiredExports.slice(1) } },
      { ...available, surface: { ...available.surface, rejectedRoutes: available.surface.rejectedRoutes.slice(1) } },
    ]) expect(validatedAvailablePromotedCliSourceContract(forgedOrMutated)).toBeUndefined();
  });
  reportPhase06Observation({ id: "P06-CLI-CONTRACT-01", status: "available", effects: "deploy=0", value: "source-only" });

  test("fails closed for a changed identity, source hash, structured surface, or unsafe route", () => {
    for (const changed of [
      { ...fixture, identity: { ...fixture.identity, sourceCommit: "0".repeat(40) } },
      { ...fixture, sourceFiles: { ...fixture.sourceFiles, "deploy-network.ts": "0".repeat(64) } },
      { ...fixture, requiredExports: fixture.requiredExports.filter((name) => name !== "uploadFilesToServers") },
      { ...fixture, rejectedRoutes: fixture.rejectedRoutes.filter((name) => name !== "executeNetworkDeploy") },
    ]) {
      expect(probePromotedCliPreSignedRoute(changed)).toEqual(expect.objectContaining({ status: "publication_unavailable" }));
    }
  });
});
