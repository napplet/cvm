import { lookup } from "node:dns/promises";
import { connect } from "node:net";

const probe = process.argv.find((argument) => argument.startsWith("--probe="))?.slice("--probe=".length);
if (!probe || !["dns", "http", "https", "ipv4", "ipv6", "private", "metadata"].includes(probe)) {
  console.error("CVM_DENIAL_PROBE:invalid:usage");
  process.exitCode = 2;
} else {
  try {
    if (probe === "dns") await lookup("example.com");
    else if (probe === "http") await fetch("http://example.com/");
    else if (probe === "https") await fetch("https://example.com/");
    else if (probe === "metadata") await fetch("http://169.254.169.254/latest/meta-data/");
    else await new Promise<void>((resolve, reject) => {
      const host = probe === "ipv6" ? "2606:4700:4700::1111" : probe === "private" ? "10.0.0.1" : "1.1.1.1";
      const socket = connect({ host, port: 443 });
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
