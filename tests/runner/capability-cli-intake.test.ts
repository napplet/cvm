import { expect, test } from "bun:test";
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { verifyCapabilityCliSourceRecipe } from "../../scripts/verify-capability-cli-source-build";

const recipePath = "toolchains/recipes/napplet-cli-0.13.0-capabilities-source-build.json";
test("capability intake binds the actual harness and reviewed lock without selecting a candidate", async () => {
  const recipe = await verifyCapabilityCliSourceRecipe();
  expect(recipe.promotion.selected).toBe(false); expect(recipe.promotion.candidate).toBeNull();
  expect(recipe.lockOverlay.sha256).not.toBe(recipe.upstream.sourceLockSha256);
  const directory = await mkdtemp(join(tmpdir(), "cvm-capability-intake-"));
  try {
    for (const field of ["source", "selection", "target"]) {
      const changed = structuredClone(recipe);
      if (field === "source") changed.upstream.commit = "0".repeat(40);
      if (field === "selection") Object.assign(changed.promotion, { selected: true });
      if (field === "target") changed.build.targets["aarch64-unknown-linux-gnu"] = "0".repeat(64);
      const path = join(directory, `${field}.json`); await writeFile(path, JSON.stringify(changed));
      await expect(verifyCapabilityCliSourceRecipe(path)).rejects.toThrow("CAPABILITY_BUILD_RECIPE_CHANGED");
    }
    for (const path of [recipePath, recipe.build.script, recipe.lockOverlay.path]) { await mkdir(dirname(join(directory, path)), { recursive: true }); await copyFile(path, join(directory, path)); }
    // The real verifier runs in a fresh process against a separately owned
    // workspace; the active source builds and their inputs remain untouched.
    const original = await readFile(join(directory, recipe.build.script), "utf8");
    await writeFile(join(directory, recipe.build.script), original + "\n");
    const child = Bun.spawn([process.execPath, resolve("scripts/verify-capability-cli-source-build.ts")], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("CAPABILITY_BUILD_INPUT_CHANGED");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
