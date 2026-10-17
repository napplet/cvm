import { expect, test } from "bun:test";
import { suggestPublicationMetadata } from "../../src/dev/publication-suggestions";
import { publicationCapabilities } from "../../src/dev-ui/publication-metadata";
import { DevelopmentPublicationArgumentsSchema } from "../../src/dev/local-publication";

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
