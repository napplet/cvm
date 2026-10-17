import { describe, expect, test } from "bun:test";
import type { Transport } from "@contextvm/mcp-sdk/shared/transport";
import type { JSONRPCMessage } from "@contextvm/mcp-sdk/types";
import { CvmMcpCompatibility } from "./mcp-compatibility";

class Host implements Transport {
  onmessage?: Transport["onmessage"];
  sent: JSONRPCMessage[] = [];
  async start() {}
  async close() {}
  async send(message: JSONRPCMessage) { this.sent.push(message); }
}
const call = (id: number, name: string, args = {}): JSONRPCMessage => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

describe("documented MCP bridge", () => {
  test("discovery only exposes remotely present, enabled tools and read project actions", async () => {
    const host = new Host(); const bridge = new CvmMcpCompatibility(host);
    const forwarded: JSONRPCMessage[] = []; bridge.onmessage = message => { forwarded.push(message); };
    await bridge.start();
    host.onmessage!({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(forwarded[0]).toHaveProperty("params", {});
    await bridge.send({ jsonrpc: "2.0", id: 1, result: { tools: ["projects", "account_status", "start_session", "cvm_admin", "unknown"].map(name => ({ name })) } });
    const result = (host.sent[0] as any).result;
    expect(result.tools.map((tool: any) => tool.name).sort()).toEqual(["account_status", "projects"]);
    const projects = result.tools.find((tool: any) => tool.name === "projects");
    expect(projects.inputSchema.type).toBe("object");
    expect(projects.inputSchema.oneOf.map((schema: any) => schema.properties.action.const)).toEqual(["list", "get"]);
  });
  test("denies writes before relay dispatch, wraps domain results, preserves errors", async () => {
    const host = new Host(); const bridge = new CvmMcpCompatibility(host);
    const forwarded: JSONRPCMessage[] = []; bridge.onmessage = message => { forwarded.push(message); };
    await bridge.start();
    host.onmessage!(call(1, "start_session"));
    host.onmessage!(call(2, "projects", { action: "rename", id: "example", title: "example" }));
    expect(forwarded).toHaveLength(0); expect(host.sent).toHaveLength(2);
    expect(host.sent.every(message => "error" in message)).toBe(true);
    host.onmessage!(call(3, "projects", { action: "list" }));
    const value = { status: "ok", projects: [], nextCursor: null };
    await bridge.send({ jsonrpc: "2.0", id: 3, result: value });
    expect((host.sent[2] as any).result).toEqual({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
    host.onmessage!(call(4, "session_status", { sessionId: "invalid" }));
    const error: JSONRPCMessage = { jsonrpc: "2.0", id: 4, error: { code: -32602, message: "invalid" } };
    await bridge.send(error); expect(host.sent[3]).toEqual(error);
  });
  test("explicit opt-in allows generation but still denies admin and funding", async () => {
    const host = new Host(); const bridge = new CvmMcpCompatibility(host, true);
    const forwarded: JSONRPCMessage[] = []; bridge.onmessage = message => { forwarded.push(message); };
    await bridge.start();
    host.onmessage!(call(1, "start_session"));
    host.onmessage!(call(2, "cvm_admin"));
    host.onmessage!(call(3, "top_up"));
    expect(forwarded).toHaveLength(1); expect(host.sent).toHaveLength(2);
  });
});
