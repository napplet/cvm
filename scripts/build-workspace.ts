import { resolve } from "node:path";
import { exportStaticWorkspace } from "../src/dev-ui/static-assets";
const source = process.env.CVM_CONFIG ?? resolve(".local/workspace/cvm.json");
const config = await Bun.file(source).json();
if (!/^[a-f0-9]{64}$/.test(config.servicePubkey) || !/^wss?:\/\//.test(config.relayUrl)) throw new Error("CVM_CONFIG_INVALID");
const destination = resolve(process.argv[2] ?? "dist/workspace");
await exportStaticWorkspace(destination, config);
console.log(`Static workspace written to ${destination}`);
