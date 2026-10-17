import type { EventTemplate } from "nostr-tools/pure";
export function prepareZapstorePublication(config: {
  version: 1; sourceDir: string; defaultTarget: "named"; relays: string[]; blossomServers: string[];
  zapstore: { id: string; name: string; summary: string; description: string; images: string[]; tags?: string[] };
}, servers: readonly string[], options: { enabled: boolean; cwd: string; createdAt: number }): Promise<{ template: EventTemplate } | undefined>;

export function createSiteManifestTemplate(item: { target: "named"; dTag: string }, files: readonly { path: string; sha256: string }[], options: { servers?: string[]; metadataTags?: string[][]; content?: string; createdAt?: number; format?: "current" | "legacy" }): Promise<EventTemplate>;
