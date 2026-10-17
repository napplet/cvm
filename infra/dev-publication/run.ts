// No keys or provider credentials enter this worker. Input is a sealed artifact.
async function run(args: string[]) {
  const child = Bun.spawn(["napplet", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${args[0]}: ${stderr.slice(-2000)}`);
  return stdout;
}
// Standalone capture uses deploy --screenshot's engine but keeps the PNG for
// durable client-side mirroring; inline deployment deletes its temporary image.
await run(["screenshot", "--artifact", "/input/index.html", "--output", "/output/screenshot.png", "--width", "1200", "--height", "750"]);
await Bun.write("/work/config.yaml", JSON.stringify({ version: 1, sourceDir: "/input", root: true, relays: [], blossomServers: ["https://media.invalid"], signing: { method: "none" }, zapstore: { id: "applet", name: "Applet", images: ["/output/screenshot.png"] } }));
const report = JSON.parse(await run(["deploy", "--format", "legacy", "--root", "--config", "/work/config.yaml", "--zapstore", "--dry-run", "--json"]));
await Bun.write("/output/application.json", JSON.stringify(report.application));
