import { resolve } from "node:path";
const instance = process.env.NAPPLET_CVM_DEV_INSTANCE;
if (instance && !/^[a-z0-9][a-z0-9-]{0,47}$/.test(instance)) throw new Error("DEV_INSTANCE_INVALID");
const record = await Bun.file(resolve(instance ? `.local/napplet-cvm-dev/${instance}/launcher.json` : ".local/napplet-cvm-dev-launcher.json")).json();
const operator = await Bun.file(resolve(record.stateRoot, "cvm-operator/operator.json")).json();
const url = new URL("/admin", record.url); url.hash = new URLSearchParams({ key: operator.adminKey }).toString();
// Pass directly to the OS browser opener. Never print the private operator key.
const child = Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url.href], { stdout: "ignore", stderr: "ignore" });
if (await child.exited) throw new Error("ADMIN_BROWSER_OPEN_FAILED");
console.log("Opened private CVM admin.");
