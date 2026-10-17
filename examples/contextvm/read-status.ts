import { Client } from "@contextvm/mcp-sdk/client";
import { NostrClientTransport } from "@contextvm/sdk/transport";
import { z } from "zod";
import { connectionOptions } from "./connection";

const client = new Client({ name: "napplet-cvm-docs", version: "1.0.0" });
try {
  await client.connect(new NostrClientTransport(await connectionOptions()));
  // The current CVM returns domain results, not MCP CallToolResult content blocks.
  const call = (name: string, args = {}) => client.request({ method: "tools/call", params: { name, arguments: args } }, z.object({}).passthrough(), { timeout: 15000 });
  console.log(JSON.stringify({ service: await call("service_info"), account: await call("account_status"), projects: await call("projects", { action: "list", limit: 5 }) }, null, 2));
} finally { await client.close(); }
