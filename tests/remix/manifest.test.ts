import { test, expect } from "bun:test";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { naddrEncode } from "applesauce-core/helpers/pointers";
import { remixAddress, remixManifest, verifiedRemixAsset } from "../../src/remix/manifest";
import { githubSource } from "../../src/dev/remix-source-import";
const key = generateSecretKey();
const html = "<!doctype html><title>A counter</title>";
const hash = new Bun.CryptoHasher("sha256").update(html).digest("hex");
const event = (tags = [["d","counter"],["x",hash]], kind = 35129) => finalizeEvent({kind,created_at:Math.floor(Date.now()/1000),tags,content:"A simple counter"},key);
test("current and legacy signed manifests resolve the exact address and asset", async () => {
 const current = event(); const address = naddrEncode({pubkey:current.pubkey,kind:35129,identifier:"counter"});
 expect(remixAddress(`nostr:${address}`).pubkey).toBe(current.pubkey);
 expect(remixManifest(current,address).artifactHash).toBe(hash); await verifiedRemixAsset(html,hash);
 expect(remixManifest(event([["d","counter"],["path","/index.html",hash],["x","a".repeat(64),"aggregate"]])).schema).toBe("legacy-path");
 expect(remixManifest(event([["x",hash]],15129)).event.kind).toBe(15129);
 expect(() => remixAddress(naddrEncode({pubkey:current.pubkey,kind:30023,identifier:"counter"}))).toThrow();
 expect(() => remixManifest(current,naddrEncode({pubkey:current.pubkey,kind:35129,identifier:"other"}))).toThrow();
 await expect(verifiedRemixAsset(html+"tampered",hash)).rejects.toThrow("signed hash");
});
test("invalid signatures, duplicate hashes and ambiguous source never become inputs", () => {
 expect(() => remixManifest({...event(),content:"tampered"})).toThrow();
 expect(() => remixManifest(event([["d","counter"],["x",hash],["x",hash]]))).toThrow();
 expect(() => remixManifest(event([["d","counter"],["x",hash],["source","https://github.com/a/b"],["source","https://github.com/c/d"]]))).toThrow();
 expect(() => remixManifest(event([["d","counter"],["x",hash],["source","https://github.com/a/b","extra"]]))).toThrow();
});
test("source fetch policy cannot select arbitrary hosts, credentials or refs", () => {
 for(const source of ["https://github.com/napplet/napplet.git","git@github.com:napplet/napplet.git","ssh://git@github.com/napplet/napplet.git"]) expect(githubSource(source)).toBe("napplet/napplet");
 for(const source of ["https://127.0.0.1/a/b","file:///etc/passwd","https://github.com.evil/a/b","https://token@github.com/a/b","https://github.com/a/b/tree/main","https://github.com/a/b?url=http://localhost","https://github.com/a/b#main","https://github.com:44/a/b"]) expect(githubSource(source)).toBeUndefined();
});
