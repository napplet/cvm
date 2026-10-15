import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LocalDevelopmentRuntimeReadiness, verifyDevelopmentHostFiles } from "../../src/dev/development-runtime-readiness";

const project = resolve(import.meta.dir, "../..");

test("real development image and both Chromium runtimes pass readiness before admission", async () => {
  const ready = await new LocalDevelopmentRuntimeReadiness().assertReady();
  expect(ready.imageDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(ready.readinessProbeDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(ready.workerBrowserVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/u);
  expect(ready.readyMonotonicMs).toBeGreaterThan(0);
}, 60_000);

test("wrong worker platform fails before container execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "napplet-readiness-platform-"));
  try {
    const dockerBin = join(root, "docker-fixture");
    await writeFile(dockerBin, `#!/usr/bin/env bun\nif(process.argv[2]!=='image')throw Error('unexpected container execution');console.log('sha256:${"a".repeat(64)}|linux|amd64');`, { mode: 0o700 });
    await expect(new LocalDevelopmentRuntimeReadiness({ dockerBin }).assertReady()).rejects.toThrow("DEV_WORKER_IMAGE_NOT_READY");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("changed host code or policy fails despite unchanged package version", async () => {
  const root = await mkdtemp(join(tmpdir(), "napplet-readiness-host-"));
  try {
    for (const path of ["infra/dev-ui/host-source.json", "tests/dev-ui/package.json", "tests/dev-ui/bun.lock", ...["@kehto/paja", "playwright", "playwright-core"].map((name) => `tests/dev-ui/node_modules/${name}/package.json`)]) {
      await mkdir(dirname(join(root, path)), { recursive: true }); await cp(join(project, path), join(root, path));
    }
    const dist = "tests/dev-ui/node_modules/@kehto/paja/dist";
    await cp(join(project, dist), join(root, dist), { recursive: true });
    expect(await verifyDevelopmentHostFiles(root)).toMatch(/^[a-f0-9]{64}$/u);
    await writeFile(join(root, dist, "index.js"), "export const tampered=true;");
    await expect(verifyDevelopmentHostFiles(root)).rejects.toThrow("DEV_HOST_CODE_MISMATCH");
    await writeFile(join(root, "infra/dev-ui/host-source.json"), '{"policy":{"sandbox":"allow-scripts allow-same-origin"}}');
    await expect(verifyDevelopmentHostFiles(root)).rejects.toThrow("DEV_HOST_PIN_MISMATCH");
  } finally { await rm(root, { recursive: true, force: true }); }
});
