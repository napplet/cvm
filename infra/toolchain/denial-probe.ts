import { lookup } from "node:dns/promises";
import { connect } from "node:net";

const probe = process.argv.find((argument) => argument.startsWith("--probe="))?.slice("--probe=".length);
if (!probe || !["dns", "http", "https", "tcp"].includes(probe)) {
  console.error("CVM_DENIAL_PROBE:invalid:usage");
  process.exitCode = 2;
} else {
  try {
    if (probe === "dns") await lookup("example.com");
    else if (probe === "http") await fetch("http://example.com/");
    else if (probe === "https") await fetch("https://example.com/");
    else await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: "1.1.1.1", port: 443 });
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", reject);
      socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error("TCP timeout")); });
    });
    console.error(`CVM_DENIAL_PROBE:${probe}:unexpected-success`);
    process.exitCode = 0;
  } catch {
    console.error(`CVM_DENIAL_PROBE:${probe}:denied`);
    process.exitCode = 1;
  }
}
