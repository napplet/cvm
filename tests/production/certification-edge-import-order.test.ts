import { expect, test } from "bun:test";

const root = process.cwd();

async function importOrder(first: string, second: string) {
  const child = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(first)}); await import(${JSON.stringify(second)});`], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  return { code, stderr: await new Response(child.stderr).text() };
}

test("certification edge and private control import in either fresh-process order", async () => {
  const edge = new URL("../../src/production/certification-edge.ts", import.meta.url).href;
  const control = new URL("../../src/release/deployment/non-google-private-control.ts", import.meta.url).href;
  for (const [first, second] of [[edge, control], [control, edge]]) {
    const result = await importOrder(first, second);
    expect(result.code, result.stderr).toBe(0);
  }
});

test("native successor broker imports and constructs while google-auth-library is blocked", async () => {
  const native = new URL("../../src/production/non-google-certification-edge.ts", import.meta.url).href;
  const successor = new URL("../../src/production/non-google-successor-control.ts", import.meta.url).href;
  const privateControl = new URL("../../src/release/deployment/non-google-private-control.ts", import.meta.url).href;
  const program = `
    Bun.plugin({ name: "block-google-auth", setup(build) {
      build.onResolve({ filter: /^google-auth-library$/u }, () => ({ path: "google-auth-library", namespace: "blocked" }));
      build.onLoad({ filter: /.*/u, namespace: "blocked" }, () => { throw new Error("GOOGLE_AUTH_MUST_NOT_IMPORT"); });
    } });
    const native = await import(${JSON.stringify(native)});
    await import(${JSON.stringify(successor)});
    await import(${JSON.stringify(privateControl)});
    const broker = native.sealNonGoogleCertificationEdgeBroker({
      candidateSha256: "a".repeat(64), topologySha256: "b".repeat(64),
      sourceBuild: { authority: "production-real", async verify() { return {}; } },
    });
    new native.NonGoogleCertificationEdgeService({ broker });
  `;
  const child = Bun.spawn([process.execPath, "-e", program], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  expect(code, await new Response(child.stderr).text()).toBe(0);
});
