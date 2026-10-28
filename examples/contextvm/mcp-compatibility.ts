import type { Transport } from "@contextvm/mcp-sdk/shared/transport";
import type { JSONRPCMessage } from "@contextvm/mcp-sdk/types";
import catalog from "../../docs/public/contracts/napplet-cvm-v1.json";

const readTools = new Set(["service_info", "account_status", "projects", "session_status", "preview", "operation_diagnostic"]);
const generationTools = new Set(["funded_admission", "approve_session_cap", "start_session", "revise_session", "resume_session"]);

/** Local compatibility for this repository's domain-result wire format. No HTTP API. */
export class CvmMcpCompatibility implements Transport {
  onmessage?: Transport["onmessage"];
  onerror?: Transport["onerror"];
  onclose?: Transport["onclose"];
  private pending = new Map<string | number, string>();
  private allowed: Set<string>;
  constructor(private host: Transport, allowGeneration = false) {
    this.allowed = new Set([...readTools, ...(allowGeneration ? generationTools : [])]);
  }
  async start() {
    this.host.onmessage = message => {
      if ("id" in message && "method" in message) {
        if (message.method === "tools/call") {
          const params = message.params as { name?: string; arguments?: { action?: string } } | undefined;
          if (!params?.name || !this.allowed.has(params.name) || (params.name === "projects" && !["list", "get"].includes(params.arguments?.action ?? ""))) {
            void this.host.send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Tool or action is not enabled in this MCP bridge" } });
            return;
          }
        } else if (!["initialize", "tools/list"].includes(message.method)) {
          void this.host.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method unavailable" } });
          return;
        }
        this.pending.set(message.id, message.method);
      }
      // The pinned server bridge expects SDK-injected request-event metadata in params.
      if ("method" in message && message.method === "tools/list" && !message.params) message = { ...message, params: {} };
      this.onmessage?.(message);
    };
    this.host.onerror = error => this.onerror?.(error);
    this.host.onclose = () => this.onclose?.();
    await this.host.start();
  }
  async send(message: JSONRPCMessage) {
    if ("id" in message && message.id !== undefined && ("result" in message || "error" in message)) {
      const method = this.pending.get(message.id); this.pending.delete(message.id);
      if ("result" in message && method === "tools/list") {
        const remote = message.result as { tools?: { name: string }[] };
        const names = new Set(remote.tools?.map(tool => tool.name));
        message = { ...message, result: { tools: catalog.tools.filter(tool => names.has(tool.name) && this.allowed.has(tool.name)).map(({ name, description, inputSchema }) => ({
          name, description, inputSchema: { type: "object", ...inputSchema, ...(name === "projects" ? { oneOf: (inputSchema as { oneOf: { properties: { action: { const: string } } }[] }).oneOf.filter(schema => ["list", "get"].includes(schema.properties.action.const)) } : {}) },
          annotations: { readOnlyHint: readTools.has(name), openWorldHint: true },
        })) } } as JSONRPCMessage;
      } else if ("result" in message && method === "tools/call") {
        const value = message.result;
        message = { ...message, result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value } } as JSONRPCMessage;
      }
    }
    await this.host.send(message);
  }
  async close() { this.pending.clear(); await this.host.close(); }
}
