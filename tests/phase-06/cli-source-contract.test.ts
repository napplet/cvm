import { describe, expect, test } from "bun:test";
import fixture from "../fixtures/phase-06-cli-source-contract.json" with { type: "json" };
import {
  NAPPLET_CLI_LINUX_SHA256,
  NAPPLET_CLI_SOURCE_COMMIT,
  probePromotedCliPreSignedRoute,
} from "../../src/publication/napplet-cli-source-contract.js";

describe("promoted napplet CLI exact-source contract", () => {
  test("accepts only the promoted commit, Linux asset, structured pre-signed route, and closed unsafe inventory", () => {
    expect(NAPPLET_CLI_SOURCE_COMMIT).toBe("1a38b9150f3a3da148091c11bce4d0365f7298e5");
    expect(NAPPLET_CLI_LINUX_SHA256).toBe("46685f2e4df516b5b2e7e2e133480c90e5c85dbd36d05c6e95f4eee6af33ec5e");
    expect(probePromotedCliPreSignedRoute(fixture)).toEqual(expect.objectContaining({
      status: "available",
      liveExecution: "not_observed",
    }));
  });

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
