import assert from "node:assert/strict";
import { resolve } from "node:path";
import { CallToolResultSchema } from "@contextvm/mcp-sdk/types";
import { Client } from "@contextvm/mcp-sdk/client";
import { StdioClientTransport } from "@contextvm/mcp-sdk/client/stdio";

const client = new Client({ name: "napplet-cvm-docs-check", version: "1.0.0" });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(import.meta.dir, "mcp-stdio.ts")], cwd: resolve(import.meta.dir, "../.."), env: { LOG_LEVEL: "silent", CVM_MCP_ALLOW_GENERATION: "0", ...(process.env.CVM_CONFIG ? { CVM_CONFIG: process.env.CVM_CONFIG } : {}), ...(process.env.CVM_CLIENT_KEY_FILE ? { CVM_CLIENT_KEY_FILE: process.env.CVM_CLIENT_KEY_FILE } : {}) }, stderr: "inherit" }));
  console.error("Connected; discovering tools");
  const { tools } = await client.listTools();
  assert.equal(tools.length, 6);
  assert(tools.every(tool => tool.inputSchema.type === "object"));
  assert(!tools.some(tool => tool.name === "start_session" || tool.name === "cvm_admin"));
  for (const [name, args] of [["service_info", {}], ["account_status", {}], ["projects", { action: "list", limit: 5 }]] as const) {
    console.error(`Reading ${name}`);
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    assert(result.content.some(block => block.type === "text"));
    assert(result.structuredContent);
  }
  await assert.rejects(client.callTool({ name: "start_session", arguments: {} }));
  await assert.rejects(client.callTool({ name: "projects", arguments: { action: "rename", id: "not-a-project", title: "blocked" } }));
  console.log("MCP verified: discovery, 3 read calls, generation and rename denied.");
} finally { await client.close(); }
