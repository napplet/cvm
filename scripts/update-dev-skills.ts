import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Run deliberately when updating guidance, never during a metered action.
const revision = process.argv[2];
if (!revision || !/^[a-f0-9]{40}$/u.test(revision)) throw new Error("Usage: bun scripts/update-dev-skills.ts <napplet/napplet commit SHA>");
const cliVersion = "1.7.2";
const names = ["napplet-make", "napplet-design", "napplet-ui", "napplet-build", "napplet-sdk", "napplet-test"];
const source = `https://github.com/napplet/napplet/tree/${revision}/skills`;
const staging = await mkdtemp(join(tmpdir(), "napplet-authoring-skills-"));
const destination = resolve(import.meta.dir, "../infra/dev-ui/authoring-skills");
try {
  const child = Bun.spawn(["npx", "--yes", `skills@${cliVersion}`, "add", source, "--skill", ...names, "--agent", "codex", "--copy", "--yes"], {
    cwd: staging, env: { ...process.env, DISABLE_TELEMETRY: "1", npm_config_fetch_timeout: "30000", npm_config_fetch_retries: "1" }, stdout: "inherit", stderr: "inherit",
  });
  if (await child.exited !== 0) throw new Error("SKILLS_INSTALL_FAILED");
  const contents = await Promise.all(names.map(async (name) => {
    const directory = join(staging, ".agents/skills", name);
    // Current skills are self-contained. Flag new supporting files for review.
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length !== 1 || entries[0]?.name !== "SKILL.md" || !entries[0].isFile()) throw new Error(`REVIEW_SKILL_SUPPORTING_FILES:${name}`);
    const bytes = await readFile(join(directory, "SKILL.md"));
    if (!bytes.toString().startsWith(`---\nname: ${name}\n`) || bytes.length > 32_000) throw new Error(`INVALID_SKILL:${name}`);
    return { name, bytes, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
  }));
  const licenseResponse = await fetch(`https://raw.githubusercontent.com/napplet/napplet/${revision}/LICENSE`, { signal: AbortSignal.timeout(30_000) });
  if (!licenseResponse.ok) throw new Error("SKILLS_LICENSE_UNAVAILABLE");
  const license = await licenseResponse.text();
  if (!license.includes("MIT License")) throw new Error("REVIEW_SKILLS_LICENSE");
  for (const { name, bytes } of contents) {
    await mkdir(join(destination, "skills", name), { recursive: true });
    await writeFile(join(destination, "skills", name, "SKILL.md"), bytes);
  }
  await writeFile(join(destination, "LICENSE"), license);
  await writeFile(join(destination, "skills-lock.json"), await readFile(join(staging, "skills-lock.json")));
  await writeFile(join(destination, "source.json"), JSON.stringify({ repository: "https://github.com/napplet/napplet", revision, installer: `skills@${cliVersion}`, skills: contents.map(({ name, sha256 }) => ({ name, sha256 })) }, null, 2) + "\n");
  console.log(`Installed ${contents.length} authoring skills at ${revision}. Rebuild the development worker before generation.`);
} finally { await rm(staging, { recursive: true, force: true }); }
