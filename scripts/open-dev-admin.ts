import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const instance = process.env.NAPPLET_CVM_DEV_INSTANCE;
if (instance && !/^[a-z0-9][a-z0-9-]{0,47}$/.test(instance)) throw new Error("DEV_INSTANCE_INVALID");
console.log("Preparing local CVM admin…");
const startup = Bun.spawn([process.execPath, resolve(root, "scripts/dev.ts"), "up"], { cwd: root, stdout: "pipe", stderr: "pipe" });
const [, diagnostic, started] = await Promise.all([new Response(startup.stdout).text(), new Response(startup.stderr).text(), startup.exited]);
if (started !== 0) {
  const code = diagnostic.match(/(?:DEV|CHATGPT|ADMIN|NWC)_[A-Z0-9_]+|ECONNREFUSED|ECONNRESET|ETIMEDOUT/u)?.[0] ?? "UNAVAILABLE";
  throw new Error(`ADMIN_DEVELOPMENT_NOT_READY:${code}: run bun scripts/dev.ts up for details`);
}
const record = await Bun.file(resolve(root, instance && instance !== "default" ? `.local/napplet-cvm-dev/${instance}/launcher.json` : ".local/napplet-cvm-dev-launcher.json")).json();
const operator = await Bun.file(resolve(record.stateRoot, "cvm-operator/operator.json")).json();
const url = new URL("/admin", record.url); url.hash = new URLSearchParams({ key: operator.adminKey }).toString();
// Force a document navigation even when the OS reuses an existing admin tab.
url.searchParams.set("launch", crypto.randomUUID());
// Pass directly to the OS browser opener. Never print the private operator key.
const child = Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url.href], { stdout: "ignore", stderr: "ignore" });
if (await child.exited) throw new Error("ADMIN_BROWSER_OPEN_FAILED");
console.log("Opened private CVM admin.");
