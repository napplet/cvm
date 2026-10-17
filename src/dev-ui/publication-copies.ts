export const MIN_PUBLICATION_SERVERS = 2;

/** Browser receipts describe hash-verified bytes. Count complete destinations,
 * not individual files or duplicate receipts. The latest receipt wins. */
export function verifiedPublicationServers(
  files: readonly { path: string }[],
  servers: readonly string[],
  receipts: readonly { server: string; file: string; state: string }[],
): string[] {
  if (!files.length) return [];
  const latest = new Map(receipts.map(item => [`${new URL(item.server).origin}\n${item.file}`, item.state]));
  return [...new Set(servers.map(server => new URL(server).origin))].filter(server => files.every(file => latest.get(`${server}\n${file.path}`) === "verified"));
}
