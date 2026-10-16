export function relayUrl(value: string): string {
  const raw = value.trim();
  if (raw.length > 512 || /[\s\\]/u.test(raw)) throw new Error("Enter a relay address such as wss://relay.example.com.");
  let url: URL; try { url = new URL(raw); } catch { throw new Error("Enter a relay address such as wss://relay.example.com."); }
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Use a ws:// or wss:// relay without credentials, queries or fragments.");
  if (url.protocol === "ws:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Use wss:// for a public relay.");
  return url.href.replace(/\/$/u, "");
}
