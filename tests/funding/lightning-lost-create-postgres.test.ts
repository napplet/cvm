import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { PostgresFundingDatabase } from "../../src/persistence/postgres-funding-database";
import { FundingService } from "../../src/funding/funding-service";
import { ProtectedRailMaterialVault } from "../../src/funding/protected-rail-material";
import { LightningTopUpCoordinator } from "../../src/funding/lightning-top-up";
import { NwcLightningReceiptPort, type AuthenticatedNwcInvoiceTransport } from "../../src/funding/nwc-receipt-port";

const integration = process.env.NAPPLET_RUN_POSTGRES_ISOLATION === "1" ? test : test.skip;
integration("restricted PostgreSQL preserves lost NWC intent across fresh repositories and concurrent settlement", async () => {
  const name = `napplet-cvm-nwc-${crypto.randomUUID().replaceAll("-", "")}`;
  const docker = async (...args: string[]) => {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 15000);
    try {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code) throw new Error(`DOCKER_${args[0]}:${err.slice(0, 300)}`); return out.trim();
    } finally { clearTimeout(timer); }
  };
  const { Pool } = createRequire(import.meta.url)("pg");
  let admin: any; let application: any;
  try {
    await docker("run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine");
    const port = (await docker("port", name, "5432/tcp")).match(/127\.0\.0\.1:(\d+)/u)?.[1];
    if (!port) throw new Error("POSTGRES_PORT_MISSING");
    admin = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    for (let attempt = 0; attempt < 60; attempt++) { try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 59) throw error; await Bun.sleep(250); } }
    for (const path of ["phase-03/001_funding.sql", "phase-04/001_metered_generation.sql", "phase-04/002_action_budget_lifecycle.sql", "phase-05/001_continuation.sql", "phase-06/001_publication.sql", "phase-03/002_production_accounting.sql", "phase-03/003_cashu_custody_and_identities.sql"]) await admin.query(await Bun.file(`migrations/${path}`).text());
    await admin.query("CREATE ROLE nwc_recovery_test LOGIN");
    await admin.query("GRANT napplet_production_real TO nwc_recovery_test");
    application = new Pool({ connectionString: `postgresql://nwc_recovery_test@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    const now = Date.parse("2026-10-27T12:00:00Z"); const principal = { pubkey: "ee".repeat(32) };
    let creates = 0; let lists = 0; let lookups = 0; let invoice: Record<string, unknown> | undefined;
    const transport: AuthenticatedNwcInvoiceTransport = {
      connectionScopeDigest: "ad".repeat(32), consentedMethods: ["make_invoice", "list_transactions", "lookup_invoice"],
      async request(method, params) {
        if (method === "make_invoice") {
          creates++;
          const row = (await admin.query("SELECT state_json FROM production_real.lightning_top_up_state WHERE state_key='global'")).rows[0];
          expect(row.state_json.topUps[0][1].originalIntent.descriptionHash).toBe(params.description_hash);
          invoice = { type: "incoming", invoice: "lnbc2500n-private-pg-test", payment_hash: "bd".repeat(32), description_hash: params.description_hash, amount: 250000, created_at: now / 1000, expires_at: now / 1000 + 600, settled_at: now / 1000, state: "settled" };
          throw new Error("lost response");
        }
        if (method === "list_transactions") { lists++; return { transactions: [invoice], total_count: 1 }; }
        lookups++; return invoice;
      },
    };
    const create = () => {
      const db = new PostgresFundingDatabase(application, { realm: "production-real", deadlineMs: 5000 });
      return { db, coordinator: new LightningTopUpCoordinator({ funding: new FundingService(db.funding), repository: db.lightning,
        vault: new ProtectedRailMaterialVault({ key: new Uint8Array(32).fill(8), repository: db.protectedMaterials }),
        receiver: new NwcLightningReceiptPort(transport, () => now), now: () => new Date(now).toISOString(), providerTimeoutMs: 10000 }) };
    };
    const first = await create().coordinator.begin({ principal, idempotencyKey: "pg-lost", amount: "250", unit: "sat", policyVersion: "v1", protocolVersion: "v1" });
    expect(first.state).toBe("reconciliation_pending");
    const results = await Promise.all(Array.from({ length: 2 }, () => create().coordinator.reconcile({ principal, topUpId: first.topUpId })));
    // Bounded serialization contention may require another query, never create.
    if (results.some(result => result.state !== "credited")) await create().coordinator.reconcile({ principal, topUpId: first.topUpId });
    expect((await new FundingService(create().db.funding).status(principal)).available).toBe("250");
    expect(creates).toBe(1); expect(lists).toBeGreaterThan(0); expect(lookups).toBeGreaterThan(0);
    expect((await admin.query("SELECT count(*)::int AS n FROM production_real.top_ups")).rows[0].n).toBe(1);
    const stored = (await admin.query("SELECT state_json FROM production_real.lightning_top_up_state WHERE state_key='global'")).rows[0].state_json;
    expect(JSON.stringify(stored)).not.toContain("lnbc2500n-private-pg-test");
    expect(stored.topUps[0][1].state).toBe("credited");
    expect((await admin.query("SELECT count(*)::int AS n FROM public.top_ups")).rows[0].n).toBe(0);
  } finally { await application?.end(); await admin?.end(); await docker("rm", "--force", name).catch(() => undefined); }
}, 120000);
