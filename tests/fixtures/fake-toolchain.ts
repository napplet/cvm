const args = new Set(process.argv.slice(2));
const value = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

if (args.has("--mode=timeout")) {
  await Bun.sleep(Number(value("--delay") ?? 100));
  console.log(JSON.stringify({ outcome: "ok" }));
} else if (args.has("--mode=non-zero")) {
  console.error("expected fixture failure");
  process.exitCode = 17;
} else if (args.has("--mode=malformed")) {
  console.log("not json");
} else if (args.has("--mode=echo")) {
  console.log(JSON.stringify({ outcome: "ok", literal: value("--literal") }));
} else {
  console.log(JSON.stringify({ outcome: "ok" }));
}
