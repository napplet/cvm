export {};

const argumentsAfterBun = process.argv.slice(2);
const fixtureIndex = argumentsAfterBun.indexOf("--fixture");
const fixture = fixtureIndex === -1 ? undefined : argumentsAfterBun[fixtureIndex + 1];
const assertHermetic = argumentsAfterBun.includes("--assert-hermetic");
if (argumentsAfterBun.some((argument, index) => argument !== "--assert-hermetic" && argument !== "--fixture" && index !== fixtureIndex + 1) || (fixtureIndex !== -1 && fixture !== "minimal" && fixture !== "capability-harness")) {
  throw new Error("usage: bun run test:promotion [--assert-hermetic] [--fixture minimal|capability-harness]");
}

if (assertHermetic) {
  const runner = await Bun.file("src/promotion/run-promotion.ts").text();
  if (!runner.includes("runSealedToolchain") || runner.includes("runHermeticCommand")) {
    throw new Error("promotion runner must reach commands only through runSealedToolchain");
  }
}

let verificationExitCode = 0;
if (fixture) {
  const verifyInputs = Bun.spawn(["bun", "run", "toolchain:image-build", "--", "--candidate", "toolchains/candidates/cli-0.5.2-release-set.json", "--verify-only"], {
    cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  verificationExitCode = await verifyInputs.exited;
}

const fixtureTest = fixture === "capability-harness" ? "tests/fixtures/capability-harness.test.ts" : "tests/fixtures/minimal.test.ts";
const tests = Bun.spawn(["bun", "test", "tests/tracer.test.ts", "tests/runner/sealed-toolchain.test.ts", ...(fixture ? [fixtureTest] : [])], {
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "" },
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = verificationExitCode === 0 ? await tests.exited : verificationExitCode;
