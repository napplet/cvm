import { expect, test } from "bun:test";
import { suggestPublicationMetadata } from "../../src/dev/publication-suggestions";
import { publicationCapabilities } from "../../src/dev-ui/publication-metadata";
import { DevelopmentPublicationArgumentsSchema } from "../../src/dev/local-publication";
import { sourceCapabilities } from "../../infra/dev-ui/source-capabilities";
import { PublicationHashtagsSchema, normalizeHashtag } from "../../src/dev-ui/publication-hashtags";
import { createSiteManifestTemplate } from "../../infra/vendor/napplet-publication/bundle/entry.js";

test("capability data is bounded, exact, and keeps optional declarations out of required", () => {
  const read = (value: unknown) => sourceCapabilities([{path:"src/capabilities.json",content:JSON.stringify(value)}]);
  expect(read({required:["storage","theme","storage"],optional:["theme"]})).toEqual({required:["storage"],optional:["theme"]});
  expect(sourceCapabilities([])).toBeUndefined();
  for (const value of [{required:["storage.get"],optional:[]},{required:[],optional:[],script:"run"},{required:"storage",optional:[]},{required:[],optional:Array(33).fill("theme")}]) expect(()=>read(value)).toThrow();
  expect(publicationCapabilities([], true)).toEqual({required:[],optional:[],legacy:false});
  expect(publicationCapabilities([], false).legacy).toBe(true);
});
test("hashtags normalize across the UI and CVM, with bounded safe input", () => {
  expect(normalizeHashtag(" #Games ")).toBe("games");
  expect(PublicationHashtagsSchema.parse(["#Games","games","日本語","daily-practice"])).toEqual(["games","日本語","daily-practice"]);
  for (const value of ["", "bad tag", "<script>", "##tag", "x".repeat(65), "https://example.com"]) expect(()=>normalizeHashtag(value)).toThrow();
  expect(PublicationHashtagsSchema.safeParse(Array(11).fill("games")).success).toBe(false);
});
test("official current CLI template preserves capabilities and hashtags with the actual artifact hash", async () => {
  const event = await createSiteManifestTemplate({target:"named",dTag:"test-applet"}, [{path:"/index.html",sha256:"a".repeat(64)}], {content:"A focused applet.",metadataTags:[["R","storage"],["O","theme"],["t","games"]]});
  expect(event.tags).toEqual(expect.arrayContaining([["x","a".repeat(64)],["R","storage"],["O","theme"],["t","games"]]));
  expect(event.tags.some(tag=>["path","requires","description"].includes(tag[0]!))).toBe(false);
  expect(event.content).toBe("A focused applet.");
});

test("verified metadata takes precedence over the project fallback", () => {
  expect(suggestPublicationMetadata([["title", "Quiet counter"], ["description", "Count a little daily practice."]], "Build a timer", 1)).toEqual({title:"Quiet counter",description:"Count a little daily practice.",basis:"manifest"});
});
test("generic older titles use bounded saved project suggestions", () => {
  const result = suggestPublicationMetadata([["title", "Generated development napplet"]], "Please build a reading counter. Use large buttons.", 6);
  expect(result.title).toBe("Reading counter"); expect(result.description).toBe("Please build a reading counter. Use large buttons.");
  expect(suggestPublicationMetadata([], "Untitled applet", 6).title).toBe("Applet version 6");
  expect(suggestPublicationMetadata([["title", "a".repeat(900)], ["description", "b".repeat(1000)]], undefined, 1).description.length).toBe(500);
});
test("capability review distinguishes legacy requirements from current required and optional declarations", () => {
  expect(publicationCapabilities([["requires","storage"],["requires","storage"],["path","/index.html","hash"]])).toEqual({required:["storage"],optional:[],legacy:true});
  expect(publicationCapabilities([["R","storage"],["O","theme"],["O","theme"]])).toEqual({required:["storage"],optional:["theme"],legacy:false});
});
test("metadata lookup cannot accept a caller-supplied owner", () => {
  const request = {action:"metadata",sessionId:"session:one",artifactId:"artifact:one"};
  expect(DevelopmentPublicationArgumentsSchema.safeParse(request).success).toBe(true);
  expect(DevelopmentPublicationArgumentsSchema.safeParse({...request,pubkey:"a".repeat(64)}).success).toBe(false);
});
