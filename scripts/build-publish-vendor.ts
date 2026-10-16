import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
for (const name of ["napplet-cli", "qrcode"]) {
  const directory = resolve(root, "infra/vendor", name);
  const provenance = await Bun.file(resolve(directory, "PROVENANCE.json")).json();
  const files = provenance.files ?? { "qrcodegen.ts": provenance.sha256 };
  for (const [file, expected] of Object.entries(files)) {
    const bytes = await Bun.file(resolve(directory, file)).arrayBuffer();
    if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== expected) throw new Error("VENDOR_SOURCE_HASH_MISMATCH");
  }
}
const result = await Bun.build({ entrypoints: [resolve(root, "infra/vendor/napplet-cli/entry.ts")], target: "bun", format: "esm", external: ["nostr-tools/*", "@scure/base", "@std/*"], outdir: resolve(root, "infra/vendor/napplet-cli/bundle") });
if (!result.success) throw new Error("CLI_LIBRARY_BUILD_FAILED");
// Bun preserves two unused external imports from the Deno file collector. Our
// exports accept verified bytes and never collect files; remove only imports
// proven unused in the generated bundle, leaving upstream source unchanged.
const cliPath = resolve(root, "infra/vendor/napplet-cli/bundle/entry.js");
let cli = await Bun.file(cliPath).text();
for (const symbol of ["contentType", "extname"]) {
  const declaration = new RegExp(`^import \\{ ${symbol} \\} from "@std/[^\"]+";\\n`, "m");
  const without = cli.replace(declaration, "");
  if (new RegExp(`\\b${symbol}\\b`).test(without)) throw new Error("CLI_UNEXPECTED_DENO_DEPENDENCY");
  cli = without;
}
await Bun.write(cliPath, cli);
const qr = await Bun.file(resolve(root, "infra/vendor/qrcode/qrcodegen.ts")).text();
const javascript = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(`${qr}\nexport { qrcodegen };\n`);
await Bun.write(resolve(root, "infra/vendor/qrcode/qr.js"), javascript);
