import { lookup } from "node:dns/promises";
import { connect } from "node:net";

const probe = process.argv.find((argument) => argument.startsWith("--probe="))?.slice("--probe=".length);
if (!probe || !["dns", "http", "https", "tcp", "metadata", "websocket"].includes(probe)) {
  console.error("CVM_DENIAL_PROBE:invalid:usage");
  process.exitCode = 2;
} else {
  try {
    if (probe === "dns") await lookup("example.com");
    else if (probe === "http") await fetch("http://example.com/");
    else if (probe === "https") await fetch("https://example.com/");
    else if (probe === "metadata") await fetch("http://169.254.169.254/latest/meta-data/");
    else if (probe === "websocket") await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket("wss://example.com/");
      socket.addEventListener("open", () => { socket.close(); resolve(); }, { once: true });
      socket.addEventListener("error", () => reject(new Error("websocket denied")), { once: true });
      setTimeout(() => { socket.close(); reject(new Error("websocket timeout")); }, 2_000);
    });
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
