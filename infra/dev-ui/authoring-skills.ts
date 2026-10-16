import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const names = ["napplet-make", "napplet-design", "napplet-ui", "napplet-build", "napplet-sdk", "napplet-test"];
const sha256 = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/** Same bounded, hash-checked installed text for the model and offline worker. */
export async function loadAuthoringSkills(directory = join(import.meta.dir, "authoring-skills")) {
  const sourceBytes = await readFile(join(directory, "source.json"));
  const source = JSON.parse(sourceBytes.toString()) as { repository: string; revision: string; skills: { name: string; sha256: string }[] };
  if (source.repository !== "https://github.com/napplet/napplet" || !/^[a-f0-9]{40}$/u.test(source.revision) || JSON.stringify(source.skills.map(({ name }) => name)) !== JSON.stringify(names)) throw new Error("DEV_AUTHORING_SKILLS_INVALID");
  const sections: string[] = [];
  for (const { name, sha256: expected } of source.skills) {
    const bytes = await readFile(join(directory, "skills", name, "SKILL.md"));
    if (bytes.length > 32_000 || sha256(bytes) !== expected) throw new Error("DEV_AUTHORING_SKILLS_MISMATCH");
    sections.push(`<skill name="${name}">\n${bytes.toString()}\n</skill>`);
  }
  const guidance = sections.join("\n\n");
  if (Buffer.byteLength(guidance) > 80_000) throw new Error("DEV_AUTHORING_SKILLS_TOO_LARGE");
  return { revision: source.revision, sha256: sha256(sourceBytes), guidance };
}

if (import.meta.main) {
  if (process.argv[2] !== "--install") throw new Error("Expected --install");
  const skills = await loadAuthoringSkills();
  // Parent workspace keeps guidance out of the artifact and template source scans.
  await mkdir("/work/.agents", { recursive: true });
  await cp(join(import.meta.dir, "authoring-skills/skills"), "/work/.agents/skills", { recursive: true });
  console.log(JSON.stringify({ revision: skills.revision, sha256: skills.sha256 }));
}
