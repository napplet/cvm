import { readdir, readFile, access } from "node:fs/promises";
import { resolve } from "node:path";

// Bun accepts a mix of existing and missing test filters. Reject stale CI
// entrypoints explicitly so extraction cannot silently reduce test coverage.
const root = resolve(import.meta.dir, "..");
let checked = 0;
for (const file of await readdir(resolve(root, ".github/workflows"))) {
  if (!/\.ya?ml$/u.test(file)) continue;
  const source = await readFile(resolve(root, ".github/workflows", file), "utf8");
  for (const command of source.matchAll(/\bbun test ([^\n]+)/gu)) {
    for (const match of command[1]!.matchAll(/\btests\/[A-Za-z0-9_./-]+/gu)) {
      const path = match[0];
      try { await access(resolve(root, path)); }
      catch { throw new Error(`CI_TEST_PATH_MISSING:${file}:${path}`); }
      checked++;
    }
  }
}
console.log(`Verified ${checked} CI test paths.`);
