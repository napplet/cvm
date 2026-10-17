import { resolve } from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { DevelopmentContextVmClient } from "../src/dev-ui/browser/contextvm-client";
import { syncDevelopmentRates } from "../src/dev/openai-price-sync";

const argumentsSet = new Set(process.argv.slice(2));
if ([...argumentsSet].some(argument => argument !== "--dry-run")) throw new Error("Usage: bun run pricing:sync [--dry-run]");
const instance = process.env.NAPPLET_CVM_DEV_INSTANCE ?? "default";
if (!/^[a-z0-9][a-z0-9-]{0,47}$/u.test(instance)) throw new Error("DEV_INSTANCE_INVALID");
const root = resolve(import.meta.dir, "..");
const recordPath = instance === "default" ? resolve(root, ".local/napplet-cvm-dev-launcher.json") : resolve(root, ".local/napplet-cvm-dev", instance, "launcher.json");
const record = JSON.parse(await readFile(recordPath, "utf8"));
const launcherUrl = new URL(record.url);
if (launcherUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(launcherUrl.hostname) || launcherUrl.username || launcherUrl.password) throw new Error("LOCAL_CVM_REQUIRED");
const operatorPath = resolve(record.stateRoot, "cvm-operator/operator.json");
const operatorStat = await lstat(operatorPath);
if (!operatorStat.isFile() || (operatorStat.mode & 0o077) !== 0) throw new Error("OPERATOR_PRIVATE_STORAGE_INVALID");
const { adminKey } = JSON.parse(await readFile(operatorPath, "utf8"));
if (typeof adminKey !== "string" || !/^[a-f0-9]{64}$/u.test(adminKey)) throw new Error("OPERATOR_ACCESS_KEY_INVALID");
const connection = await (await fetch(new URL("/cvm.json", launcherUrl), { signal: AbortSignal.timeout(5_000) })).json();
const client = new DevelopmentContextVmClient({ ...connection, reserveSat: "0", actionCeilingSat: "0", providerLabel: "CVM" }, undefined, adminKey);
try {
  await client.connect({ accountStatus: false });
  console.log(JSON.stringify(await syncDevelopmentRates(client, { dryRun: argumentsSet.has("--dry-run") }), null, 2));
} finally { await client.close(); }
