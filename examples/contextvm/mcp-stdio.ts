import { StdioServerTransport } from "@contextvm/mcp-sdk/server/stdio";
import { NostrMCPProxy } from "@contextvm/sdk/proxy";
import { connectionOptions } from "./connection";
import { CvmMcpCompatibility } from "./mcp-compatibility";

const proxy = new NostrMCPProxy({
  mcpHostTransport: new CvmMcpCompatibility(new StdioServerTransport(), process.env.CVM_MCP_ALLOW_GENERATION === "1"),
  nostrTransportOptions: await connectionOptions(),
  paymentOptions: { paymentInteraction: "transparent" },
});
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await proxy.stop(); }
process.once("SIGINT", () => { void stop().finally(() => process.exit()); });
process.once("SIGTERM", () => { void stop().finally(() => process.exit()); });
process.stdin.once("end", () => { void stop().finally(() => process.exit()); });
await proxy.start();
