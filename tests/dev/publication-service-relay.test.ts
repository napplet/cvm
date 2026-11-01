import { expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { publishOnUserRelays } from "../../src/dev/publication-relays";

const event = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: "x" }, generateSecretKey());

test("a private internal service relay is accepted as configuration and per-relay failures stay contained", async () => {
  // No relay is listening; each relay reports its own failure instead of aborting publication.
  const results = await publishOnUserRelays(["wss://cvm.example.invalid/relay", "wss://192.168.1.10/relay"], event, { internal: "ws://relay.invalid:8080", public: "wss://cvm.example.invalid/relay" }, true);
  expect(results.map((result) => [result.relay, result.state])).toEqual([["wss://cvm.example.invalid/relay", "failed"], ["wss://192.168.1.10/relay", "failed"]]);
});
