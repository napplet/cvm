import { describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { writeRelays, relaySuggestions } from "../../src/dev-ui/browser/relay-discovery";
import { relayUrl } from "../../src/dev-ui/destinations";
import { blossomServer } from "../../src/dev-ui/browser/blossom-client";
import { publicRelayAddress, publishOnUserRelays } from "../../src/dev/publication-relays";
const owner = generateSecretKey(); const other = generateSecretKey();
const event = (tags: string[][], kind = 10002, created_at = 1000, key = owner) => finalizeEvent({ tags, kind, created_at, content: "" }, key);
describe("publication destinations", () => {
  test("NIP-65 uses only latest valid owner write relays, with no fallback", () => {
    expect(writeRelays([event([["r","wss://old.example"]],10002,800), event([["r","wss://both.example/"],["r","wss://write.example","write"],["r","wss://read.example","read"],["r","https://wrong.example"]]), event([["r","wss://other.example"]],10002,1100,other)],getPublicKey(owner),1100)).toEqual(["wss://both.example","wss://write.example"]);
    expect(writeRelays([event([["r","wss://old.example"]],10002,800),event([])],getPublicKey(owner),1100)).toEqual([]);
    const forged = JSON.parse(JSON.stringify(event([["r","wss://forged.example"]]))); forged.pubkey = getPublicKey(other);
    expect(writeRelays([forged],getPublicKey(other),1100)).toEqual([]);
    expect(writeRelays([event([["r","wss://future.example"]],10002,2000)],getPublicKey(owner),1100)).toEqual([]);
  });
  test("NIP-66 suggestions require recent independent reports and successful writes", () => {
    const tags = [["d","wss://suggest.example"],["rtt-write","25"]];
    expect(relaySuggestions([event(tags,30166)],1100)).toEqual([]);
    expect(relaySuggestions([event(tags,30166),event(tags,30166,1000,other)],1100)).toEqual(["wss://suggest.example"]);
    expect(relaySuggestions([event(tags,30166),event([...tags,["R","payment"]],30166,1000,other)],1100)).toEqual([]);
    expect(relaySuggestions([event(tags,30166),event(tags,30166,1000,other)],90000)).toEqual([]);
  });
  test("addresses normalize duplicates and reject schemes, credentials and ambiguous input", () => {
    expect(relayUrl(" wss://RELAY.example/ ")).toBe("wss://relay.example");
    expect(blossomServer("https://BLOSSOM.example/")).toBe("https://blossom.example");
    for (const value of ["https://relay.example", "wss://user:secret@relay.example", "wss://relay.example/#x", "wss://relay.example/?key=x", "ws://relay.example", "wss://relay.example\nother"]) expect(() => relayUrl(value)).toThrow();
    for (const value of ["javascript:alert(1)","https://user:secret@blossom.example", "https://blossom.example/path","http://blossom.example"]) expect(() => blossomServer(value)).toThrow();
  });
  test("service publication rejects private targets other than the configured development relay", async () => {
    for (const value of ["127.0.0.1","10.0.0.5","169.254.169.254","192.168.1.1","100.64.1.1","::1","::ffff:127.0.0.1","fc00::1","2001:db8::1"]) expect(publicRelayAddress(value)).toBe(false);
    expect(publicRelayAddress("8.8.8.8")).toBe(true); expect(publicRelayAddress("2606:4700:4700::1111")).toBe(true);
    expect((await publishOnUserRelays(["wss://127.0.0.1:1"],event([],35129),"ws://127.0.0.1:2",true))[0]?.state).toBe("failed");
  });
});
