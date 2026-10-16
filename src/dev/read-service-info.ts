import { randomBytes } from "node:crypto";
import { DevelopmentContextVmClient } from "../dev-ui/browser/contextvm-client";
/** Launcher uses the same public static connection document and signed CVM
 * discovery as a separately hosted website. No HTTP service-control backdoor. */
export async function readServiceInfo(url: string) {
  const config = await (await fetch(`${url}/cvm.json`, { signal: AbortSignal.timeout(5000) })).json() as { relayUrl: string; servicePubkey: string };
  const client = new DevelopmentContextVmClient({ ...config, reserveSat: "0", actionCeilingSat: "0", providerLabel: "CVM" }, undefined, randomBytes(32).toString("hex"));
  try { await client.connect({ accountStatus: false }); return await client.callTool("service_info", {}); }
  finally { await client.close(); }
}
