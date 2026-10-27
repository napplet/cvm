import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalNappletWorker } from "../../src/dev/local-napplet-worker";
import { canonicalJson } from "../../src/promotion/schema";

const files = [{ path: "src/main.ts", content: "export {};" }];
const sha256 = new Bun.CryptoHasher("sha256").update(canonicalJson({ files })).digest("hex");
const proposal = { proposalSha256: sha256, proposal: { reference: `proposal:sha256:${sha256}`, sha256, files } };

for (const mode of ["timeout", "overflow"] as const) {
  test(`worker ${mode} kills its subprocess and removes only its exact container`, async () => {
    const root = await mkdtemp(join(tmpdir(), "napplet-worker-lifecycle-")); const log = join(root, "commands.jsonl"); const dockerBin = join(root, "docker-fixture");
    try {
      // Lifecycle fault fixture only; real Docker/build/browser coverage is in generation-preview.e2e.ts.
      await writeFile(dockerBin, `#!/usr/bin/env bun\nimport {appendFile} from 'node:fs/promises';\nconst args=process.argv.slice(2); await appendFile(${JSON.stringify(log)},JSON.stringify(args)+'\\n');\nif(args[0]==='image') { console.log('sha256:${"b".repeat(64)}|linux|${process.arch === "x64" ? "amd64" : "arm64"}'); }\nelse if(args[0]==='run') { ${mode === "overflow" ? "process.stdout.write('x'.repeat(20000));" : ""} await new Promise(resolve=>setTimeout(resolve,60000)); }\n`, { mode: 0o700 });
      const worker = new LocalNappletWorker({ dockerBin, deadlineMs: mode === "overflow" ? 3_000 : 250, maxOutputBytes: 1024 });
      await expect(worker.materialize(proposal)).rejects.toThrow(mode === "timeout" ? "WORKER_DEADLINE_EXCEEDED" : "WORKER_OUTPUT_LIMIT_EXCEEDED");
      const commands: string[][] = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const run = commands.find((args) => args[0] === "run")!; const name = run[run.indexOf("--name") + 1];
      expect(name).toMatch(/^napplet-cvm-dev-worker-/u);
      expect(run[run.indexOf("--user") + 1]).toMatch(/^[1-9]\d*:[1-9]\d*$/u);
      expect(run[run.indexOf("--network") + 1]).toBe("none");
      expect(run[run.indexOf("--cap-drop") + 1]).toBe("ALL");
      expect(run[run.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
      expect(run.at(-2)).toBe(`sha256:${"b".repeat(64)}`);
      expect(commands.filter((args) => args[0] === "rm")).toEqual([["rm", "--force", name!]]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 10_000);
}

test("worker limits cannot be disabled by non-finite or fractional values", () => {
  for (const value of [NaN, Infinity, -1, 0, 1.5]) {
    expect(() => new LocalNappletWorker({ deadlineMs: value })).toThrow("WORKER_LIMIT_INVALID");
    expect(() => new LocalNappletWorker({ maxOutputBytes: value })).toThrow("WORKER_LIMIT_INVALID");
  }
});

test("proposal digest and protected surface are checked before invoking Docker", async () => {
  const worker = new LocalNappletWorker({ dockerBin: "/does-not-exist" });
  await expect(worker.materialize({ ...proposal, proposalSha256: "a".repeat(64) })).rejects.toThrow("WORKER_SOURCE_PROPOSAL_INVALID");
  const protectedFiles = [{ path: "package.json", content: "{}" }]; const digest = new Bun.CryptoHasher("sha256").update(canonicalJson({ files: protectedFiles })).digest("hex");
  await expect(worker.materialize({ proposalSha256: digest, proposal: { reference: `proposal:sha256:${digest}`, sha256: digest, files: protectedFiles } })).rejects.toThrow();
});
