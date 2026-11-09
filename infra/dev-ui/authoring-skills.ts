import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const names = ["napplet-make", "napplet-design", "napplet-ui", "napplet-build", "napplet-sdk", "napplet-test"];
const sha256 = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/** Same bounded, hash-checked installed text for the model and offline worker. */
export type AuthoringSkill = Readonly<{ name: string; sha256: string; content: string }>;

/**
 * The generated-app worker and the model use exactly the same, pinned source.
 * Keep this loader deliberately small: callers receive no filesystem path and
 * can only address a manifest entry by name.
 */
export async function loadAuthoringSkillCatalog(directory = join(import.meta.dir, "authoring-skills")): Promise<Readonly<{ revision: string; sha256: string; skills: readonly AuthoringSkill[] }>> {
  const sourceBytes = await readFile(join(directory, "source.json"));
  const source = JSON.parse(sourceBytes.toString()) as { repository: string; revision: string; skills: { name: string; sha256: string }[]; resources?: { name: string; sha256: string; repository: string; revision: string; license: string; licenseFile: string; licenseSha256: string }[] };
  if (source.repository !== "https://github.com/napplet/napplet" || !/^[a-f0-9]{40}$/u.test(source.revision) || JSON.stringify(source.skills.map(({ name }) => name)) !== JSON.stringify(names)) throw new Error("DEV_AUTHORING_SKILLS_INVALID");
  const resources = source.resources ?? [];
  if (resources.length > 12 || resources.some(resource => !/^(gsap|threejs)-[a-z-]+$/.test(resource.name) || !/^https:\/\/github.com\/(greensock\/gsap-skills|CloudAI-X\/threejs-skills)$/.test(resource.repository) || !/^[a-f0-9]{40}$/.test(resource.revision) || resource.license !== 'MIT' || !/^(gsap|threejs)-LICENSE$/.test(resource.licenseFile))) throw new Error('DEV_AUTHORING_SKILLS_INVALID');
  for (const resource of resources) {
    if (sha256(await readFile(join(directory, resource.licenseFile))) !== resource.licenseSha256) throw new Error('DEV_AUTHORING_SKILLS_LICENSE_MISMATCH');
  }
  const entries = [...source.skills, ...resources];
  if (new Set(entries.map(entry => entry.name)).size !== entries.length) throw new Error('DEV_AUTHORING_SKILLS_INVALID');
  const skills: AuthoringSkill[] = [];
  for (const { name, sha256: expected } of entries) {
    const bytes = await readFile(join(directory, "skills", name, "SKILL.md"));
    if (bytes.length > 32_000 || sha256(bytes) !== expected) throw new Error("DEV_AUTHORING_SKILLS_MISMATCH");
    skills.push(Object.freeze({ name, sha256: expected, content: bytes.toString() }));
  }
  const guidance = skills.map((skill) => `<skill name="${skill.name}">\n${skill.content}\n</skill>`).join("\n\n");
  if (Buffer.byteLength(guidance) > 256_000) throw new Error("DEV_AUTHORING_SKILLS_TOO_LARGE");
  return Object.freeze({ revision: source.revision, sha256: sha256(sourceBytes), skills: Object.freeze(skills) });
}

/** Compatibility surface for the offline worker's existing installer. */
export async function loadAuthoringSkills(directory = join(import.meta.dir, "authoring-skills")) {
  const catalog = await loadAuthoringSkillCatalog(directory);
  return Object.freeze({ revision: catalog.revision, sha256: catalog.sha256, guidance: catalog.skills.map((skill) => `<skill name="${skill.name}">\n${skill.content}\n</skill>`).join("\n\n") });
}

if (import.meta.main) {
  if (process.argv[2] !== "--install") throw new Error("Expected --install");
  const skills = await loadAuthoringSkills();
  // Parent workspace keeps guidance out of the artifact and template source scans.
  await mkdir("/work/.agents", { recursive: true });
  await cp(join(import.meta.dir, "authoring-skills/skills"), "/work/.agents/skills", { recursive: true });
  console.log(JSON.stringify({ revision: skills.revision, sha256: skills.sha256 }));
}
