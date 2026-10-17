import type { EventTemplate } from "nostr-tools/pure";
export function prepareZapstorePublication(config: {
  version: 1; sourceDir: string; defaultTarget: "named"; relays: string[]; blossomServers: string[];
  zapstore: { id: string; name: string; summary: string; description: string; images: string[] };
}, servers: readonly string[], options: { enabled: boolean; cwd: string; createdAt: number }): Promise<{ template: EventTemplate } | undefined>;
