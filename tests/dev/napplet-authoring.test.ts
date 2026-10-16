import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAuthoringSkills } from "../../infra/dev-ui/authoring-skills";
import { nappletAuthoringInstructions } from "../../src/dev/napplet-authoring";

test("installed skills reach the model with the bounded service contract intact", async () => {
  const skills = await loadAuthoringSkills();
  const instructions = await nappletAuthoringInstructions("Return only the requested JSON source files.");
  expect(instructions).toContain(skills.guidance);
  expect(instructions.indexOf("SERVICE EXECUTION CONTRACT")).toBeGreaterThan(instructions.lastIndexOf("</skill>"));
  expect(instructions).toContain("Return only the requested JSON source files.");
  expect(instructions).toContain("You have no tools in this source-generation turn");
  expect(instructions).toContain("Only src/main.ts and src/styles.css can change");
  expect(instructions).toContain("No title header");
  // Leaves room for the existing bounded prior source + prompt + JSON framing.
  expect(Buffer.byteLength(JSON.stringify(instructions)) + 128_000 + 20_000).toBeLessThan(262_144);
});

test("modified, missing or renamed installed skills fail before use", async () => {
  const directory = await mkdtemp(join(tmpdir(), "napplet-skills-test-"));
  try {
    await cp(resolve(import.meta.dir, "../../infra/dev-ui/authoring-skills"), directory, { recursive: true });
    const original = await loadAuthoringSkills(directory);
    const path = join(directory, "skills/napplet-ui/SKILL.md");
    const bytes = await readFile(path);
    await writeFile(path, "tampered");
    await expect(loadAuthoringSkills(directory)).rejects.toThrow("DEV_AUTHORING_SKILLS_MISMATCH");
    await writeFile(path, bytes);
    expect(await loadAuthoringSkills(directory)).toEqual(original);
    await rm(path);
    await expect(loadAuthoringSkills(directory)).rejects.toThrow();
    await writeFile(path, bytes);
    const manifest = JSON.parse(await readFile(join(directory, "source.json"), "utf8"));
    manifest.skills[0].name = "../../unexpected";
    await writeFile(join(directory, "source.json"), JSON.stringify(manifest));
    await expect(loadAuthoringSkills(directory)).rejects.toThrow("DEV_AUTHORING_SKILLS_INVALID");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
