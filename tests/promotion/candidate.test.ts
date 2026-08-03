import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFERRED_PROMOTION_PINS, detectCandidate, verifyCandidateReviewReadiness } from "../../src/promotion/candidate";
import { parsePromotionManifest } from "../../src/promotion/schema";

const sha256 = (character: string) => character.repeat(64);
const commit = (character: string) => character.repeat(40);
const origin = "https://example.invalid/evidence";

function packageRecord(name: string, version: string, sourceCommit: string) {
  return {
    name,
    version,
    integrity: "sha512-c2FmZS1pbnRlZ3JpdHk=",
    publisher: "official-publisher",
    registryOrigin: origin,
    authoritativeRepository: "https://example.invalid/upstream",
    sourceCommit,
    sourceMapping: "official source release commit",
    sourceEvidenceOrigin: "https://example.invalid/upstream/commit",
  };
}

function candidateInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    status: "review_ready",
    reviewScope: "provenance-intake",
    protocol: {
      nip5dRevision: commit("a"),
      nip5dEvidenceOrigin: "https://example.invalid/nip-5d",
      napRevisions: [],
    },
    packages: [
      packageRecord("@napplet/sdk", "0.27.2", commit("d")),
      packageRecord("@napplet/skills", "0.3.1", commit("e")),
    ],
    cli: {
      packageName: "napplet",
      version: "0.5.1",
      distributionType: "github-release-asset",
      distribution: "https://example.invalid/releases/napplet-linux-x86_64",
      authoritativeRepository: "https://example.invalid/upstream",
      releaseTag: "@napplet/cli@0.5.1",
      releaseAsset: "napplet-linux-x86_64",
      releaseAssetSha256: sha256("f"),
      sourceCommit: commit("2"),
      sourceMapping: "official release tag resolves to source commit",
      releaseEvidenceOrigin: "https://example.invalid/releases/tag",
      sourceEvidenceOrigin: "https://example.invalid/source/tag",
      executablePath: null,
      executableSha256: null,
    },
    deferredPromotionPins: [...DEFERRED_PROMOTION_PINS],
    lockfileSha256: null,
    scaffoldRevision: null,
    imageDigest: null,
    runtimeVersion: null,
    pnpmVersion: null,
    browserVersion: null,
    conformanceVersion: null,
    fixtures: [],
    goldens: [],
    policyVersion: null,
    workingDirectory: null,
    stages: [],
    evidence: [{ origin, sha256: sha256("a") }],
    unresolved: [],
    ...overrides,
  };
}

describe("pre-install provenance candidates", () => {
  test("accepts exactly complete provenance while deferring D-04 materialization", async () => {
    const exact = await verifyCandidateReviewReadiness(candidateInput());
    expect(exact.status).toBe("review_ready");
    expect(exact.blockers).toEqual([]);
    expect(exact.record.deferredPromotionPins).toEqual(DEFERRED_PROMOTION_PINS);

    const prematureNap = await verifyCandidateReviewReadiness(candidateInput({
      protocol: { ...candidateInput().protocol as Record<string, unknown>, napRevisions: [commit("b")] },
    }));
    expect(prematureNap.status).toBe("unverified");
    expect(prematureNap.blockers).toContain("protocol.napRevisions must remain deferred until Plans 04-11");

    const prematureImage = await verifyCandidateReviewReadiness(candidateInput({ imageDigest: sha256("1") }));
    expect(prematureImage.status).toBe("unverified");
    expect(prematureImage.blockers).toContain("imageDigest must remain deferred until Plans 04-11");
  });

  test("requires package and standalone CLI provenance facts instead of guessed identity", async () => {
    for (const overrides of [
      { packages: [{ ...packageRecord("@napplet/sdk", "0.27.2", commit("d")), publisher: "" }] },
      { packages: [{ ...packageRecord("@napplet/sdk", "latest", commit("d")) }] },
      { packages: [{ ...packageRecord("@napplet/sdk", "0.27.2", commit("d")), sourceEvidenceOrigin: "" }] },
      { cli: { ...candidateInput().cli as Record<string, unknown>, distributionType: "npm" } },
      { cli: { ...candidateInput().cli as Record<string, unknown>, releaseAssetSha256: "" } },
      { cli: { ...candidateInput().cli as Record<string, unknown>, sourceCommit: null } },
    ]) {
      const result = await verifyCandidateReviewReadiness(candidateInput(overrides));
      expect(result.status).toBe("unverified");
      expect(result.blockers.length).toBeGreaterThan(0);
    }
  });

  test("canonicalizes unordered package provenance but changes identity with any reviewed fact", async () => {
    const first = await detectCandidate(candidateInput());
    const reversed = await detectCandidate(candidateInput({ packages: [...(candidateInput().packages as unknown[])].reverse() }));
    expect(reversed.candidateId).toBe(first.candidateId);

    const changed = await detectCandidate(candidateInput({
      packages: [packageRecord("@napplet/sdk", "0.27.2", commit("f")), packageRecord("@napplet/skills", "0.3.1", commit("e"))],
    }));
    expect(changed.candidateId).not.toBe(first.candidateId);

    const duplicate = await verifyCandidateReviewReadiness(candidateInput({
      packages: [...(candidateInput().packages as unknown[]), (candidateInput().packages as unknown[])[0]!],
    }));
    expect(duplicate.status).toBe("unverified");
    expect(duplicate.blockers.some((blocker) => blocker.includes("duplicate package"))).toBeTrue();
  });

  test("keeps the complete D-04 PromotionManifest parser strict", () => {
    expect(() => parsePromotionManifest({
      schemaVersion: 1,
      status: "candidate",
      protocol: { nip5dRevision: commit("a"), napRevisions: [commit("b")] },
      packages: [{ name: "@napplet/sdk", version: "0.27.2", integrity: "sha512-c2FmZS1pbnRlZ3JpdHk=", sourceCommit: commit("c") }],
      executables: [{ path: "/opt/napplet/bin/napplet", sha256: sha256("d") }],
      lockfileSha256: sha256("e"),
      scaffoldRevision: commit("f"),
      imageDigest: "",
      runtimeVersion: "bun-1.3.14",
      browserVersion: "chromium-140",
      fixtures: [{ name: "minimal", revision: commit("1"), sha256: sha256("2") }],
      goldens: [{ name: "minimal", revision: commit("3"), sha256: sha256("4") }],
      policyVersion: "policy-1",
      workingDirectory: "/workspace/napplet",
      stages: [{ id: "verify", executable: "/opt/napplet/bin/napplet", argv: ["verify"], timeoutMs: 1_000, expectedOutput: {} }],
    })).toThrow("manifest.imageDigest must be a non-empty string");
  });
});

test("candidate CLI accepts --review-ready after the candidate path", async () => {
  const repositoryRoot = join(import.meta.dir, "..", "..");
  const process = Bun.spawn([Bun.which("bun")!, "run", "candidate:verify", "--", "toolchains/candidates/initial.json", "--review-ready"], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await process.exited).toBe(0);
  const result = JSON.parse(await new Response(process.stdout).text()) as { status: string; blockers: string[] };
  expect(result.status).toBe("review_ready");
  expect(result.blockers).toEqual([]);
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

  const invokedScripts = `${packageJson.scripts["candidate:detect"]}\n${packageJson.scripts["candidate:verify"]}`.toLowerCase();
  for (const forbidden of [
    "npm install", "pnpm install", "bun install", "npx", "postinstall", "preinstall", "prepare", "toolchains/current.json", "goldens/", "git push", "gh pr", "promotion",
  ]) {
    expect(workflow.toLowerCase()).not.toContain(forbidden);
  }
  for (const forbidden of ["npm install", "pnpm install", "bun install", "npx", "postinstall", "preinstall", "prepare", "toolchains/current.json", "goldens/", "run-promotion"]) {
    expect(invokedScripts).not.toContain(forbidden);
  }
});
