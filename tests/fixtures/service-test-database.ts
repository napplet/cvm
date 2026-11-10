import { createRequire } from "node:module";
import { applyCanonicalMigrations, initializeServiceRealm } from "../../src/service/migrations";
import type { ServicePool } from "../../src/service/funding";

/** Disposable application schema without wallet services or payment implementation. */
export async function serviceTestDatabase() {
  const container = `cvm-core-test-${crypto.randomUUID().slice(0, 8)}`;
  const run = async (...args: string[]) => {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(`TEST_POSTGRES_FAILED:${args[0]}:${error.slice(-300)}`);
    return out.trim();
  };
  let pool: ServicePool | undefined;
  const close = async () => { try { await pool?.end(); } finally { await run("rm", "--force", container); } };
  try {
    await run("run", "--rm", "--detach", "--name", container, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.11-alpine3.24");
    const port = (await run("port", container, "5432/tcp")).match(/127\.0\.0\.1:(\d+)/u)![1];
    const { Pool } = createRequire(import.meta.url)("pg") as { Pool: new (options: Record<string, unknown>) => ServicePool };
    pool = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; ; attempt++) { try { await pool.query("SELECT 1"); break; } catch (error) { if (attempt > 100) throw error; await Bun.sleep(100); } }
    await applyCanonicalMigrations(pool); await initializeServiceRealm(pool, "test");
    return { pool, close };
  } catch (error) { await close().catch(() => undefined); throw error; }
}
