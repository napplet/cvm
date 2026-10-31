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
