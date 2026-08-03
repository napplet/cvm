const argumentsAfterBun = process.argv.slice(2);
if (argumentsAfterBun.some((argument) => argument !== "--assert-hermetic")) {
  throw new Error("usage: bun run test:promotion --assert-hermetic");
}

if (argumentsAfterBun.includes("--assert-hermetic")) {
  const runner = await Bun.file("src/promotion/run-promotion.ts").text();
  if (!runner.includes("runSealedToolchain") || runner.includes("runHermeticCommand")) {
    throw new Error("promotion runner must reach commands only through runSealedToolchain");
  }
}

const tests = Bun.spawn(["bun", "test", "tests/tracer.test.ts", "tests/runner/sealed-toolchain.test.ts"], {
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "" },
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await tests.exited;
