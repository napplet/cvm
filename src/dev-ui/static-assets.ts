import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "../..");
export async function buildStaticWorkspace(connection: { relayUrl: string; servicePubkey: string }): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of ["index.html", "console.html", "admin.html", "product.css", "styles.css", "admin.css"]) files.set(name, await readFile(resolve(root, "src/dev-ui/browser", name), "utf8"));
  for (const [entry, name] of [["main.ts", "app.js"], ["admin.ts", "admin.js"]]) {
    const build = await Bun.build({ entrypoints: [resolve(root, "src/dev-ui/browser", entry!)], target: "browser", format: "esm", minify: true,
      plugins: [{ name: "contextvm-browser-pino", setup(builder) { builder.onResolve({ filter: /^pino$/ }, () => ({ path: resolve(root, "src/dev-ui/browser/pino-browser-shim.ts") })); } }],
    });
    if (!build.success) throw new Error(`STATIC_BUILD_FAILED:${build.logs.map(item => item.message).join(";")}`);
    files.set(name!, await build.outputs[0]!.text());
  }
  files.set("cvm.json", JSON.stringify({ relayUrl: connection.relayUrl, servicePubkey: connection.servicePubkey }));
  return files;
}
export async function exportStaticWorkspace(directory: string, connection: { relayUrl: string; servicePubkey: string }) {
  const files = await buildStaticWorkspace(connection); await mkdir(directory, { recursive: true });
  for (const [name, content] of files) if (!name.startsWith("admin.")) await writeFile(resolve(directory, name), content);
}
