import { sourceCapabilities } from "/opt/source-capabilities.ts";
import { cp, readFile, writeFile } from "node:fs/promises";
const stages: any[] = [];
async function run(name: string, argv: string[], cwd = "/work/project") {
  console.log(`NAPPLET_STAGE ${JSON.stringify({ name, state: "running" })}`);
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: { HOME: "/home/napplet", CI: "1", PLAYWRIGHT_BROWSERS_PATH: "/opt/ms-playwright", PATH: process.env.PATH! } });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  stages.push({ name, exitCode, stdout: stdout.slice(-40_000), stderr: stderr.slice(-20_000) });
  console.log(`NAPPLET_STAGE ${JSON.stringify({ name, state: exitCode === 0 ? "completed" : "failed" })}`);
  if (exitCode !== 0) throw new Error(name);
}
try {
  const proposal = await Bun.file("/input/proposal.json").json() as { files: { path: string; content: string }[] };
  await run("create", ["napplet", "create", "/work/project", "--template", "/opt/template"], "/work");
  await run("init", ["napplet", "init", "--root", "--force", "--source-dir", "dist", "--title", "Generated development napplet"]);
  await run("skills", ["bun", "/opt/authoring-skills.ts", "--install"], "/work");
  const html = await readFile("/work/project/index.html", "utf8"); await writeFile("/work/project/index.html", html.replace("<head>", "<head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'\">"));
  for (const file of proposal.files) await writeFile(`/work/project/${file.path}`, file.content);
  const capabilities = sourceCapabilities(proposal.files);
  if (capabilities) {
    const artifactHtml = await readFile("/work/project/index.html", "utf8");
    const metadata = `<meta name="napplet-requires" content="${capabilities.required.join(" ")}"><meta name="napplet-optional" content="${capabilities.optional.join(" ")}">`;
    await writeFile("/work/project/index.html", artifactHtml.replace("</head>", `${metadata}</head>`));
  }
  if (capabilities?.required.length) {
    const config = await readFile("/work/project/vite.config.ts", "utf8");
    if (!config.includes("nip5aManifest({")) throw new Error("CAPABILITY_CONFIG_SURFACE_CHANGED");
    await writeFile("/work/project/vite.config.ts", config.replace("nip5aManifest({", `nip5aManifest({requires: ${JSON.stringify(capabilities.required)},`));
  }
  const pnpm = ["node", "/opt/pnpm/bin/pnpm.cjs"];
  await run("install", [...pnpm, "install", "--offline", "--frozen-lockfile", "--ignore-scripts", "--store-dir", "/opt/pnpm-store"]); Bun.spawnSync(["chmod", "-R", "a+rx", "/work/project/node_modules"]);
  await run("build", ["node", "./node_modules/vite/bin/vite.js", "build"]);
  await run("verify", ["sh", "-c", "node --test tests/guidance.test.mjs && node ./node_modules/typescript/bin/tsc --noEmit && node ./node_modules/vite/bin/vite.js build"]);
  await run("conformance", ["sh", "-c", "node ./node_modules/vite/bin/vite.js build && node ./node_modules/@napplet/conformance-cli/dist/cli.js ./dist"]);
  await run("dry-run", ["napplet", "deploy", "--dry-run", "--json", "--root"]);
  await cp("/work/project/dist", "/output/dist", { recursive: true });
} finally { await writeFile("/output/report.json", JSON.stringify({ stages })); }
