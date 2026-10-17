import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicationScreenshot } from "../../src/dev/publication-media";
import type { LocalArtifactRepository, SealedArtifact } from "../../src/dev/local-artifact-repository";

test("cached publication screenshots are reusable, artifact-bound and byte-verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "publication-media-test-"));
  const id = "a".repeat(64); const directory = join(root, "screenshots", id);
  const artifact = { artifactId: `artifact:sha256:${id}` } as SealedArtifact;
  const repository = { read() { throw new Error("Cache reuse must not execute a worker or read source"); } } as unknown as LocalArtifactRepository;
  const bytes = new Uint8Array(await Bun.file(new URL("../fixtures/publication-screenshot.png", import.meta.url)).arrayBuffer());
  const file = { path: "screenshot.png" as const, bytes: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
  const record = { artifactId: artifact.artifactId, toolchain: "b".repeat(64), file };
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, file.path), bytes);
    await writeFile(join(directory, "record.json"), JSON.stringify(record));
    expect((await publicationScreenshot(root, repository, artifact)).file).toEqual(file);
    await writeFile(join(directory, file.path), new Uint8Array(bytes.length));
    await expect(publicationScreenshot(root, repository, artifact)).rejects.toThrow("ARTIFACT_FILE_HASH_MISMATCH");
    await rm(join(directory, file.path));
    await writeFile(join(root, "elsewhere.png"), bytes);
    await symlink(join(root, "elsewhere.png"), join(directory, file.path));
    await expect(publicationScreenshot(root, repository, artifact)).rejects.toThrow();
    await writeFile(join(directory, "record.json"), JSON.stringify({ ...record, artifactId: `artifact:sha256:${"c".repeat(64)}` }));
    await expect(publicationScreenshot(root, repository, artifact)).rejects.toThrow("PUBLICATION_SCREENSHOT_BINDING_CHANGED");
  } finally { await rm(root, { recursive: true, force: true }); }
});
