import { expect, test } from "bun:test";
import { CLI_SOURCE_BUILD_PROFILES, parseCliSourceBuildArguments } from "../../scripts/rebuild-napplet-cli-source";

test("source rebuild keeps the historical default and explicitly selects a pinned capability profile", () => {
  expect(parseCliSourceBuildArguments(["--output", "/tmp/unused-source-profile"])).toEqual({ output: "/tmp/unused-source-profile", profileName: "legacy" });
  expect(parseCliSourceBuildArguments(["--profile", "capabilities-0.13.0", "--output", "/tmp/unused-source-profile"])).toEqual({ output: "/tmp/unused-source-profile", profileName: "capabilities-0.13.0" });
  expect(CLI_SOURCE_BUILD_PROFILES.legacy.commit).toBe("976ad0549c38f93d4ed418d3ea59a615a7e5fd7f");
  expect(CLI_SOURCE_BUILD_PROFILES["capabilities-0.13.0"].commit).toBe("3c6e3ae33fea425b2f151740c0bd8c02f509ef7b");
  expect(Object.isFrozen(CLI_SOURCE_BUILD_PROFILES)).toBe(true);
  expect(Object.isFrozen(CLI_SOURCE_BUILD_PROFILES["capabilities-0.13.0"])).toBe(true);
  for (const argv of [[], ["--profile", "latest", "--output", "/tmp/unused-source-profile"], ["--profile", "https://other/source", "--output", "/tmp/unused-source-profile"], ["--output", "/tmp/unused-source-profile", "--commit", "other"], ["--profile", "capabilities-0.13.0"], ["--output", ""]]) expect(() => parseCliSourceBuildArguments(argv)).toThrow("Usage:");
});
