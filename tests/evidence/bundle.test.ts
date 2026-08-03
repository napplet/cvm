import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateEvidenceBundle, writeEvidenceBundle } from "../../src/evidence/bundle";

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    verdict: { status: "review-ready", responsibleStage: "none" },
    manifest: { candidateId: "a".repeat(64), sha256: "b".repeat(64) },
    nativeReports: [{ id: "native", sha256: "c".repeat(64) }],
    integrationResults: [{ id: "tracer", reportDigests: ["c".repeat(64)] }],
    artifacts: { sha256: "d".repeat(64), goldenSha256: "e".repeat(64) },
    reproducibility: { status: "matched", diffSha256: "f".repeat(64) },
    provenance: { links: ["https://example.invalid/source"] },
    ...overrides,
  };
}

describe("writeEvidenceBundle", () => {
  test("canonicalizes object insertion order and persists one immutable bundle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "napplet-cvm-evidence-"));
    try {
      const first = await writeEvidenceBundle(directory, evidence());
      const reordered = {
        provenance: { links: ["https://example.invalid/source"] },
        reproducibility: { diffSha256: "f".repeat(64), status: "matched" },
        artifacts: { goldenSha256: "e".repeat(64), sha256: "d".repeat(64) },
        integrationResults: [{ reportDigests: ["c".repeat(64)], id: "tracer" }],
        nativeReports: [{ sha256: "c".repeat(64), id: "native" }],
        manifest: { sha256: "b".repeat(64), candidateId: "a".repeat(64) },
        verdict: { responsibleStage: "none", status: "review-ready" },
      };
      const second = await writeEvidenceBundle(directory, reordered);
      expect(second.evidenceSha256).toBe(first.evidenceSha256);
      expect(await Bun.file(join(directory, `${first.evidenceSha256}.json`)).exists()).toBeTrue();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed on missing layers, missing report references, and altered digest", async () => {
    await expect(writeEvidenceBundle("/tmp/unused", evidence({ artifacts: undefined }))).rejects.toThrow("artifacts");
    await expect(writeEvidenceBundle("/tmp/unused", evidence({ integrationResults: [{ id: "tracer", reportDigests: ["0".repeat(64)] }] }))).rejects.toThrow("report digest");
    const bundle = await writeEvidenceBundle(await mkdtemp(join(tmpdir(), "napplet-cvm-evidence-")), evidence());
    expect(() => validateEvidenceBundle({ ...bundle, evidenceSha256: "0".repeat(64) })).toThrow("digest");
  });
});
