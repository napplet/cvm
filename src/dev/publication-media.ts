import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { readVerifiedArtifactFile } from "./local-artifact-verifier";
import { runBoundedDevelopmentCommand } from "./local-napplet-worker";
import type { LocalArtifactRepository, SealedArtifact } from "./local-artifact-repository";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Record = z.object({ artifactId: z.string(), toolchain: Digest, file: z.object({ path: z.literal("screenshot.png"), sha256: Digest, bytes: z.number().int().positive().max(2_000_000) }).strict() }).strict();
type Capture = { file: z.infer<typeof Record>["file"]; bytes: Uint8Array };
const active = new Map<string, Promise<Capture>>();
const hash = (value: Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

function png(bytes: Uint8Array) {
  const data = Buffer.from(bytes);
  if (data.length < 24 || data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || data.toString("ascii", 12, 16) !== "IHDR" || data.readUInt32BE(16) !== 1200 || data.readUInt32BE(20) !== 750) throw new Error("PUBLICATION_SCREENSHOT_INVALID");
}

/** CLI capture of sealed bytes only, offline in an ephemeral restricted container.
 * The cache is per artifact, so signing retries and title edits never recapture. */
export async function publicationScreenshot(root: string, repository: LocalArtifactRepository, artifact: SealedArtifact): Promise<Capture> {
  const directory = join(root, "screenshots", Digest.parse(artifact.artifactId.slice("artifact:sha256:".length)));
  async function cached(): Promise<Capture | undefined> {
    let record;
    try { record = Record.parse(JSON.parse(await readFile(join(directory, "record.json"), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (record.artifactId !== artifact.artifactId) throw new Error("PUBLICATION_SCREENSHOT_BINDING_CHANGED");
    const bytes = await readVerifiedArtifactFile(directory, record.file); png(bytes);
    return { file: record.file, bytes };
  }
  const prior = await cached(); if (prior) return prior;
  const pending = active.get(directory); if (pending) return pending;
  if (active.size >= 2) throw new Error("PUBLICATION_SCREENSHOT_BUSY");
  const operation = (async () => {
    const inspected = await runBoundedDevelopmentCommand(["docker", "image", "inspect", "napplet-cvm/dev-publication:development", "--format", "{{.Id}}"], { deadlineMs: 15000, maxBytes: 2000 });
    const image = inspected.stdout.trim();
    if (inspected.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("PUBLICATION_SCREENSHOT_TOOLCHAIN_MISSING");
    const scratch = await mkdtemp(join(tmpdir(), "napplet-publication-"));
    const input = join(scratch, "input"), output = join(scratch, "output");
    const name = `napplet-cvm-publication-${crypto.randomUUID()}`;
    try {
      await mkdir(input); await mkdir(output); await chmod(output, 0o777);
      for (const file of artifact.files) {
        const stored = await repository.read({ artifactId: artifact.artifactId, path: file.path });
        if (!stored || hash(stored.bytes) !== file.sha256) throw new Error("PUBLICATION_FILE_CHANGED");
        const target = join(input, file.path); await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, stored.bytes, { flag: "wx", mode: 0o444 });
      }
      const run = await runBoundedDevelopmentCommand(["docker", "run", "--name", name, "--rm", "--network", "none", "--read-only", "--user", "65532:65532", "--cpus", "2", "--memory", "2g", "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=512m", "--tmpfs", "/work:rw,nosuid,nodev,size=16m", "--tmpfs", "/home/napplet:rw,nosuid,nodev,size=16m", "-v", `${input}:/input:ro`, "-v", `${output}:/output:rw`, image], { deadlineMs: 90000, maxBytes: 16000 });
      if (run.exitCode !== 0) throw new Error("PUBLICATION_SCREENSHOT_FAILED", { cause: run.stderr.slice(-2000) });
      // Inventory using the same bounded, no-follow checks as generated files.
      const { collectArtifactFiles } = await import("./local-artifact-verifier");
      const inventory = await collectArtifactFiles(output);
      const file = Record.shape.file.parse(inventory.find(file => file.path === "screenshot.png"));
      const bytes = await readVerifiedArtifactFile(output, file); png(bytes);
      const report = inventory.find(file => file.path === "application.json");
      if (!report) throw new Error("PUBLICATION_APPLICATION_MISSING");
      const application = JSON.parse(new TextDecoder().decode(await readVerifiedArtifactFile(output, report)));
      if (application.template?.kind !== 32267 || !application.template.tags.some((tag: string[]) => tag[0] === "image" && tag[1] === `https://media.invalid/${file.sha256}`) || application.files?.[0]?.sha256 !== file.sha256) throw new Error("PUBLICATION_APPLICATION_MISMATCH");
      await mkdir(join(root, "screenshots"), { recursive: true, mode: 0o700 });
      const stage = await mkdtemp(join(root, "screenshots", ".capture-"));
      try {
        await writeFile(join(stage, file.path), bytes, { flag: "wx", mode: 0o400 });
        await writeFile(join(stage, "record.json"), JSON.stringify({ artifactId: artifact.artifactId, toolchain: image.slice(7), file }), { flag: "wx", mode: 0o400 });
        try { await rename(stage, directory); } catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      } finally { await rm(stage, { recursive: true, force: true }); }
      return (await cached())!;
    } finally {
      await runBoundedDevelopmentCommand(["docker", "rm", "--force", name], { deadlineMs: 5000, maxBytes: 2000 }).catch(() => undefined);
      await rm(scratch, { recursive: true, force: true });
    }
  })();
  active.set(directory, operation);
  try { return await operation; } finally { active.delete(directory); }
}
