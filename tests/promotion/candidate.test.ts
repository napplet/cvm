import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { detectCandidate, verifyCandidateReviewReadiness } from "../../src/promotion/candidate";

const sha256 = (character: string) => character.repeat(64);
const commit = (character: string) => character.repeat(40);

function candidateInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    status: "unverified",
    protocol: {
      nip5dRevision: commit("a"),
      napRevisions: [commit("b"), commit("c")],
    },
    packages: [
      { name: "@napplet/sdk", version: "0.27.2", integrity: "sha512-sdk", sourceCommit: commit("d") },
      { name: "@napplet/skills", version: "0.3.1", integrity: "sha512-skills", sourceCommit: commit("e") },
    ],
    cli: {
      packageName: "@napplet/cli",
      distribution: "https://github.com/napplet/napplet/releases/download/v0.5.0/napplet",
      releaseAssetSha256: sha256("f"),
      executablePath: "/opt/napplet/bin/napplet",
      executableSha256: sha256("1"),
      sourceCommit: commit("2"),
    },
    lockfileSha256: sha256("3"),
    scaffoldRevision: commit("4"),
    imageDigest: sha256("5"),
    runtimeVersion: "bun-1.3.14",
    pnpmVersion: "10.24.0",
    browserVersion: "chromium-140.0.7339.127",
    conformanceVersion: "0.2.18",
    fixtures: [{ name: "minimal", revision: commit("6"), sha256: sha256("7") }],
    goldens: [{ name: "minimal", revision: commit("8"), sha256: sha256("9") }],
    policyVersion: "policy-1",
    workingDirectory: "/workspace/napplet",
    stages: [
      { id: "create", executable: "/opt/napplet/bin/napplet", argv: ["create"], timeoutMs: 1_000, expectedOutput: {} },
      { id: "init", executable: "/opt/napplet/bin/napplet", argv: ["init"], timeoutMs: 1_000, expectedOutput: {} },
      { id: "skills-install", executable: "/opt/napplet/bin/napplet", argv: ["skills", "install"], timeoutMs: 1_000, expectedOutput: {} },
      { id: "build", executable: "/opt/napplet/bin/napplet", argv: ["build"], timeoutMs: 1_000, expectedOutput: {} },
      { id: "verify", executable: "/opt/napplet/bin/napplet", argv: ["verify"], timeoutMs: 1_000, expectedOutput: {} },
      { id: "conformance", executable: "/opt/napplet/bin/napplet", argv: ["conformance"], timeoutMs: 1_000, expectedOutput: {} },
      { id: "dry-run", executable: "/opt/napplet/bin/napplet", argv: ["deploy", "--dry-run"], timeoutMs: 1_000, expectedOutput: {} },
    ],
    evidence: [{ origin: "https://example.invalid/provenance.json", sha256: sha256("a") }],
    unresolved: [],
    ...overrides,
  };
}

describe("candidate detection", () => {
  test("accepts only the contiguous public workflow sequence", async () => {
    const exact = await verifyCandidateReviewReadiness(candidateInput({ status: "review_ready" }));
    expect(exact.status).toBe("review_ready");

    for (const stages of [
      [...(candidateInput().stages as unknown[]), { id: "extra", executable: "/opt/napplet/bin/napplet", argv: [], timeoutMs: 1, expectedOutput: {} }],
      (candidateInput().stages as unknown[]).filter((stage) => (stage as { id: string }).id !== "build"),
      [...(candidateInput().stages as unknown[]), (candidateInput().stages as unknown[])[0]!],
      [...(candidateInput().stages as unknown[])].reverse(),
    ]) {
      const result = await verifyCandidateReviewReadiness(candidateInput({ stages }));
      expect(result.status).toBe("unverified");
      expect(result.blockers.some((blocker) => blocker.includes("stage"))).toBeTrue();
    }
  });

  test("canonicalizes unordered package records without reordering execution", async () => {
    const first = await detectCandidate(candidateInput());
    const reversed = await detectCandidate(candidateInput({ packages: [...(candidateInput().packages as unknown[])].reverse() }));
    expect(reversed.candidateId).toBe(first.candidateId);
    expect(reversed.record.stages.map((stage) => stage.id)).toEqual(["create", "init", "skills-install", "build", "verify", "conformance", "dry-run"]);

    const changed = await detectCandidate(candidateInput({ runtimeVersion: "bun-1.3.15" }));
    expect(changed.candidateId).not.toBe(first.candidateId);

    const duplicate = await verifyCandidateReviewReadiness(candidateInput({
      packages: [...(candidateInput().packages as unknown[]), (candidateInput().packages as unknown[])[0]!],
    }));
    expect(duplicate.status).toBe("unverified");
    expect(duplicate.blockers.some((blocker) => blocker.includes("duplicate package"))).toBeTrue();
  });

  test("keeps incomplete provenance machine-readable and rejects empty identity facts", async () => {
    const unresolved = await verifyCandidateReviewReadiness(candidateInput({
      cli: { ...candidateInput().cli as Record<string, unknown>, sourceCommit: null },
      unresolved: [{ field: "cli.sourceCommit", reason: "exact release/source mapping has not been verified" }],
    }));
    expect(unresolved.status).toBe("unverified");
    expect(unresolved.blockers).toContain("cli.sourceCommit: exact release/source mapping has not been verified");

    for (const overrides of [
      { packages: [{ ...((candidateInput().packages as unknown[])[0] as Record<string, unknown>), name: "" }] },
      { cli: { ...candidateInput().cli as Record<string, unknown>, executablePath: "" } },
      { cli: { ...candidateInput().cli as Record<string, unknown>, executableSha256: "" } },
      { protocol: { nip5dRevision: "", napRevisions: [commit("b")] } },
      { imageDigest: "" },
      { runtimeVersion: "" },
    ]) {
      const result = await verifyCandidateReviewReadiness(candidateInput(overrides));
      expect(result.status).toBe("unverified");
      expect(result.blockers.length).toBeGreaterThan(0);
    }
  });

  test("treats every NIP-5D or NAP revision as an independent unverified review subject", async () => {
    const current = await detectCandidate(candidateInput({
      unresolved: [{ field: "cli.sourceCommit", reason: "pending provenance review" }],
      cli: { ...candidateInput().cli as Record<string, unknown>, sourceCommit: null },
    }));
    const newerNip = await detectCandidate(candidateInput({
      protocol: { nip5dRevision: commit("d"), napRevisions: [commit("b"), commit("c")] },
      unresolved: [{ field: "cli.sourceCommit", reason: "pending provenance review" }],
      cli: { ...candidateInput().cli as Record<string, unknown>, sourceCommit: null },
    }));
    const newerNap = await detectCandidate(candidateInput({
      protocol: { nip5dRevision: commit("a"), napRevisions: [commit("b"), commit("e")] },
      unresolved: [{ field: "cli.sourceCommit", reason: "pending provenance review" }],
      cli: { ...candidateInput().cli as Record<string, unknown>, sourceCommit: null },
    }));

    expect(current.status).toBe("unverified");
    expect(newerNip.status).toBe("unverified");
    expect(newerNap.status).toBe("unverified");
    expect(newerNip.candidateId).not.toBe(current.candidateId);
    expect(newerNap.candidateId).not.toBe(current.candidateId);
  });
});

test("candidate workflow has read-only candidate evidence authority", async () => {
  const repositoryRoot = join(import.meta.dir, "..", "..");
  const workflow = await Bun.file(join(repositoryRoot, ".github", "workflows", "toolchain-candidate.yml")).text();
  const packageJson = await Bun.file(join(repositoryRoot, "package.json")).json() as { scripts: Record<string, string> };

  expect(workflow).toMatch(/workflow_dispatch:/);
  expect(workflow).toMatch(/schedule:/);
  expect(workflow).toMatch(/permissions:\s*\n\s*contents: read/);
  expect(workflow).toContain("candidate:detect");
  expect(workflow).toContain("candidate:verify");
  expect(workflow).toContain("candidate_id=");
  expect(workflow).toContain("evidence_sha256=");
  expect(packageJson.scripts["candidate:workflow-check"]).toContain("candidate workflow");
  expect(packageJson.scripts["candidate:detect"]).toBe("bun run src/promotion/candidate.ts");
  expect(packageJson.scripts["candidate:verify"]).toBe("bun run src/promotion/candidate.ts");

  for (const forbidden of [
    "npm install", "pnpm install", "bun install", "npx", "postinstall", "preinstall", "prepare", "toolchains/current.json", "goldens/", "git push", "gh pr", "promotion",
  ]) {
    expect(workflow.toLowerCase()).not.toContain(forbidden);
    expect(`${packageJson.scripts["candidate:detect"]}\n${packageJson.scripts["candidate:verify"]}`.toLowerCase()).not.toContain(forbidden);
  }
});
