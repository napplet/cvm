import type { Event, EventTemplate } from "nostr-tools/pure";
export function createSiteManifestTemplate(item: { target: "root" | "named"; dTag?: string }, files: readonly { path: string; sha256: string }[], options?: { createdAt?: number; servers?: string[]; metadataTags?: string[][] }): Promise<EventTemplate>;
export function computeAggregateHash(files: readonly { path: string; sha256: string }[]): Promise<string>;
export function publishEventWithSimplePool(relays: string[], event: Event): Promise<Array<{ relay: string; eventId: string; success: boolean; error?: string }>>;
export function createUploadAuthorization(signer: { sign(template: EventTemplate): Promise<Event> }, hashes: readonly string[], now?: () => number, server?: string, encoding?: "base64url" | "base64"): Promise<string>;
