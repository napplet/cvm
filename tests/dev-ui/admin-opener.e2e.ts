/** Exercise the actual opener, signed admin and stopped-dependency recovery. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "./node_modules/playwright";

const root = resolve(import.meta.dir, "../.."), instance = `admin-auth-${crypto.randomUUID().slice(0,8)}`;
const temporary = await mkdtemp(join(tmpdir(), "cvm-admin-open-")), bin = join(temporary, "bin"), captured = join(temporary, "launch");
await mkdir(bin);
// Capture in a private file, never stdout/stderr or assertion diagnostics.
const opener = join(bin, process.platform === "darwin" ? "open" : "xdg-open");
await writeFile(opener, '#!/bin/sh\numask 077\nprintf "%s" "$1" > "$ADMIN_TEST_CAPTURE"\n', { mode: 0o700 });
await chmod(opener, 0o700);
const env = { ...process.env, NAPPLET_CVM_DEV_INSTANCE: instance, ADMIN_TEST_CAPTURE: captured, PATH: bin + ":" + process.env.PATH };
async function run(args: string[]) {
  const child = Bun.spawn(args, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`ADMIN_OPENER_COMMAND_FAILED:${args.slice(1).join(" ")}:${stderr.match(/ADMIN_DEVELOPMENT_NOT_READY:[A-Z_]+/u)?.[0] ?? "FAILED"}`);
  return { stdout, stderr };
}
const browser = await chromium.launch(); const page = await browser.newPage();
const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
let launched = false;
try {
  const output = await run([process.execPath, "scripts/open-dev-admin.ts"]); launched = true;
  const first = new URL(await readFile(captured, "utf8"));
  const key = new URLSearchParams(first.hash.slice(1)).get("key")!;
  assert(/^[a-f0-9]{64}$/u.test(key)); assert(first.searchParams.has("launch"));
  assert(!output.stdout.includes(key) && !output.stderr.includes(key));
  try { await page.goto(first.href); } catch { throw new Error("ADMIN_LAUNCH_NAVIGATION_FAILED"); }
  await page.locator("#admin-content").waitFor({ state: "visible" });
  assert(await page.locator("#admin-content").isVisible());
  assert(!page.url().includes(key) && !page.url().includes("launch="));
  console.log("Admin opener: initial signed login passed.");
  await page.locator("#admin-lock").click(); await page.locator("#admin-login").waitFor({ state: "visible" });
  // Simulate opening the link into the same locked document: no initial reload.
  await page.evaluate(key => { location.hash = new URLSearchParams({key}).toString(); }, key);
  await page.locator("#admin-content").waitFor({ state: "visible" });
  assert(await page.locator("#admin-content").isVisible());
  console.log("Admin opener: reused document login passed.");
  const recordPath = resolve(root, ".local/napplet-cvm-dev", instance, "launcher.json");
  const before = JSON.parse(await readFile(recordPath, "utf8"));
  await run(["docker", "compose", "--env-file", "/dev/null", "-p", `napplet-cvm-payments-${instance}`, "-f", "infra/dev-payments/compose.yaml", "stop", "postgres", "relay"]);
  assert((await fetch(first.origin + "/health")).ok, "Reproduce HTTP alive with CVM dependencies stopped");
  await run([process.execPath, "scripts/open-dev-admin.ts"]);
  const second = new URL(await readFile(captured, "utf8"));
  const after = JSON.parse(await readFile(recordPath, "utf8"));
  assert(before.pid !== after.pid && first.search !== second.search);
  assert(new URLSearchParams(second.hash.slice(1)).get("key") === key, "Recovery must retain the existing operator key");
  try { await page.goto(second.href); } catch { throw new Error("ADMIN_RECOVERY_NAVIGATION_FAILED"); }
  await page.locator("#admin-content").waitFor({ state: "visible" });
  await page.locator("#jobs-range").waitFor();
  assert(await page.locator("#admin-content").isVisible()); assert.deepEqual(errors, []);
  console.log(JSON.stringify({status:"passed",case:"admin-opener",checks:["actual CLI starts services","signed admin auto-login","private key not printed or retained in URL","reused locked tab authenticates","HTTP-alive stopped dependencies recover","operator key retained"]}));
} finally {
  await browser.close();
  if (launched) { await run([process.execPath, "scripts/dev.ts", "reset", "--confirm"]); await rm(resolve(root, ".local/napplet-cvm-dev", instance), { recursive: true, force: true }); }
  await rm(temporary, { recursive: true, force: true });
}
