import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

export const NOSTRBOOK_TOOLS = Object.freeze(["read_nip", "read_kind", "read_tag", "read_protocol", "read_nips_index"] as const);
type NostrbookTool = typeof NOSTRBOOK_TOOLS[number];

/** Fixed local MCP process. Neither callers nor model output select an executable. */
export async function readNostrbook(tool: NostrbookTool, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const schemas = {
    read_nip: (value: Record<string, unknown>) => typeof value.nip === 'string' && /^[0-9A-F]{2}$/.test(value.nip),
    read_kind: (value: Record<string, unknown>) => Number.isSafeInteger(value.kind) && Number(value.kind) >= 0 && Number(value.kind) <= 65535,
    read_tag: (value: Record<string, unknown>) => typeof value.tag === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value.tag),
    read_protocol: (value: Record<string, unknown>) => typeof value.doc === 'string' && /^[a-z0-9-]{1,64}$/.test(value.doc),
    read_nips_index: (value: Record<string, unknown>) => Object.keys(value).length === 0,
  };
  if (!args || typeof args !== 'object' || Array.isArray(args) || !schemas[tool]?.(args)) throw new Error('NOSTRBOOK_ARGUMENTS_INVALID');
  const transport = new StdioClientTransport({ command: "/usr/local/bin/nostrbook", stderr: "ignore", maxBufferSize: 512 * 1024 });
  const client = new Client({ name: "napplet-cvm", version: "1.0.0" });
  try {
    signal.throwIfAborted();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
    await client.connect(transport, { signal: deadline, timeout: 8_000 });
    const result = CallToolResultSchema.parse(await client.callTool({ name: tool, arguments: args }, CallToolResultSchema, { signal: deadline, timeout: 8_000 }));
    const text = result.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
    if (!text || Buffer.byteLength(text) > 480 * 1024) throw new Error("NOSTRBOOK_RESULT_INVALID");
    const bytes = Buffer.from(text);
    return bytes.length <= 24 * 1024 ? text : bytes.subarray(0, 23 * 1024).toString("utf8") + "\n[Document truncated at the tool result limit.]";
  } finally { await transport.close().catch(() => undefined); }
}
