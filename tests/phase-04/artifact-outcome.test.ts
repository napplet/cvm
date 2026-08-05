import { describe, expect, test } from "bun:test";
import { canonicalToolchainId, parsePromotionManifest } from "../../src/promotion/schema";
import { ProjectNappletHarness } from "../../src/phase-04/napplet-harness";
import type { WorkerPort } from "../../src/phase-02/contracts";
import type { ArtifactVerifier } from "../../src/phase-02/trusted-core";
import { runFailedArtifactProbe, runVerifiedArtifactProbe } from "../support/phase-04/session-artifact-probes";
import type { LifecycleObservation } from "../../src/telemetry/contracts";

const manifest = parsePromotionManifest({
  schemaVersion: 1, status: "candidate", protocol: { nip5dRevision: "a".repeat(40), napRevisions: ["b".repeat(40)] },
  packages: [{ name: "@napplet/skills", version: "0.3.1", integrity: "sha512-test", sourceCommit: "c".repeat(40) }],
  executables: [{ path: "/toolchain/bin/napplet", sha256: "d".repeat(64) }], lockfileSha256: "e".repeat(64), scaffoldRevision: "f".repeat(40), imageDigest: "1".repeat(64), runtimeVersion: "bun-1.2", browserVersion: "chromium-pinned",
  fixtures: [{ name: "fixture", revision: "2".repeat(40), sha256: "3".repeat(64) }], goldens: [{ name: "golden", revision: "4".repeat(40), sha256: "5".repeat(64) }], policyVersion: "phase-02-policy-2026-08-04", workingDirectory: "/workspace",
  stages: ["make-napplet", "design-napplet", "build-napplet", "test-napplet"].map((id) => ({ id, executable: "/toolchain/bin/napplet", argv: [id], timeoutMs: 1000, expectedOutput: {} })),
});

async function request() {
  return {
    principalId: "principal:owner", sessionId: "session:stable", actionId: "revision:1", expectedVersion: 1, policyVersion: "phase-02-policy-2026-08-04", capabilityGrant: "coordinator-grant", workspaceId: "workspace:session:stable", idea: "Make the counter support reset.", actionKind: "revision" as const,
    workspaceLineage: "workspace:session:stable", snapshotReference: "snapshot:1", priorArtifactId: "artifact:verified:1", approvedApplicationSurfaces: ["src/app.ts"],
    toolchain: { toolchainId: await canonicalToolchainId(manifest), manifest, evidence: { build: "evidence:build", forbiddenAuthority: "evidence:forbidden", verify: "evidence:verify", conformance: "evidence:browser" } },
  };
}

function completedWorker(): WorkerPort {
  return { async run(value) {
    return { status: "completed", code: "WORKER_PROPOSALS_VALIDATED", events: [{ kind: "tool_proposal", turn: 1, request: { sessionId: value.sessionId, actionId: value.actionId, expectedVersion: value.expectedVersion, policyVersion: value.policyVersion, capabilityGrant: value.capabilityGrant, workspaceId: value.workspaceId, callId: "capture", evidenceId: "worker-evidence", tool: "capture_evidence", label: "generated" } }], artifact: { sessionId: value.sessionId, actionId: value.actionId, expectedVersion: value.expectedVersion, policyVersion: value.policyVersion, capabilityGrant: value.capabilityGrant, workspaceId: value.workspaceId, artifactId: "artifact:candidate:2", purpose: { kind: "focused", statements: ["one focused napplet"] }, surface: { hasBackend: false, hasSecondPurpose: false, serviceWorker: false, dynamicAuthority: false }, dependencies: { appOwnedSignerOrRelay: false, privateNappletImport: false }, capabilities: { declaredHard: ["storage"], observedDomains: ["storage"], optionalIntentPresenceRead: false, intentUsedThroughSdk: false }, upstream: { scanner: { verdict: "pass", checkId: "upstream:scanner" }, conformance: { verdict: "pass", checkId: "upstream:conformance" } } } };
  } };
}

const passingVerifier: ArtifactVerifier = { async verify(facts) {
  if (facts.result.status !== "completed") return undefined;
  return { artifact: { artifactId: facts.result.artifact.artifactId, artifactSha256: "a".repeat(64), scannerReportSha256: "b".repeat(64), conformanceReportSha256: "c".repeat(64) }, contractInput: facts.result.artifact };
} };

describe("project napplet harness artifact truth", () => {
  test("executes the fixed promoted workflow and only returns a verified candidate after all server gates", async () => {
    const probe = await runVerifiedArtifactProbe();
    expect(probe).toMatchObject({ workerCalls: 1, result: { status: "verified", artifactId: "artifact:candidate:2", workflow: ["make-napplet", "design-napplet", "build-napplet", "test-napplet"] } });
    const observations: LifecycleObservation[] = [];
    const harness = new ProjectNappletHarness({ worker: completedWorker(), artifactVerifier: passingVerifier, telemetry: { observe: (observation) => { observations.push(observation); } } });
    const result = await harness.run(await request());
    expect(result).toMatchObject({ status: "verified", artifactId: "artifact:candidate:2", workflow: ["make-napplet", "design-napplet", "build-napplet", "test-napplet"] });
    expect(result).not.toHaveProperty("previewUrl");
    expect(result).not.toHaveProperty("publish");
    expect(observations).toEqual([expect.objectContaining({ stage: "validation", outcome: "succeeded", correlationDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) })]);
  });

  test("retains the prior artifact with redacted diagnostics for incomplete or validation failures", async () => {
    const probe = await runFailedArtifactProbe();
    expect(probe).toMatchObject({ workerCalls: 1, result: { status: "validation_failed", priorArtifactId: "artifact:verified:1", diagnostic: { code: "ARTIFACT_CONTRACT_BLOCKED" } } });
    const unavailable: WorkerPort = { async run() { return { status: "unavailable", code: "WORKER_UNAVAILABLE" }; } };
    const blockedHarness = new ProjectNappletHarness({ worker: unavailable, artifactVerifier: passingVerifier });
    const blocked = await blockedHarness.run(await request());

    const failingVerifier: ArtifactVerifier = { async verify(facts) {
      if (facts.result.status !== "completed") return undefined;
      return { artifact: { artifactId: facts.result.artifact.artifactId, artifactSha256: "a".repeat(64), scannerReportSha256: "b".repeat(64), conformanceReportSha256: "c".repeat(64) }, contractInput: { ...facts.result.artifact, surface: { ...facts.result.artifact.surface, dynamicAuthority: true } } };
    } };
    const validationHarness = new ProjectNappletHarness({ worker: completedWorker(), artifactVerifier: failingVerifier });
    const invalid = await validationHarness.run(await request());

    for (const result of [blocked, invalid]) {
      expect(result).toMatchObject({ priorArtifactId: "artifact:verified:1", diagnostic: { code: expect.any(String), evidenceIds: expect.any(Array) } });
      expect(JSON.stringify(result)).not.toContain("Make the counter support reset");
      expect(result).not.toHaveProperty("previewUrl");
      expect(result).not.toHaveProperty("source");
    }
    expect(blocked).toMatchObject({ status: "incomplete", diagnostic: { code: "WORKER_UNAVAILABLE" } });
    expect(invalid).toMatchObject({ status: "validation_failed", diagnostic: { code: "ARTIFACT_CONTRACT_BLOCKED" } });
  });
});
