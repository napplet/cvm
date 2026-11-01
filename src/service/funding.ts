import { HttpResponseError, JSONInt, MintOperationError, NetworkError, type RequestFn, type RequestOptions } from "@cashu/cashu-ts";
import { z } from "zod";
import { FundingService } from "../funding/funding-service";
import { CashuMintPolicyRegistry } from "../funding/cashu-mint-policy";
import { CashuTsSettlementAdapter } from "../funding/cashu-provider";
import { CashuTopUpCoordinator } from "../funding/cashu-top-up";
import { LightningTopUpCoordinator } from "../funding/lightning-top-up";
import { ProtectedRailMaterialVault } from "../funding/protected-rail-material";
import { PostgresFundingDatabase } from "../persistence/postgres-funding-database";
import type { PostgresSqlClient, PostgresSqlPool } from "../persistence/postgres-sql-funding-store";
import { NwcInvoiceReceiver, type NwcRelayPolicy } from "./nwc";

export type ServicePool = PostgresSqlPool & Pick<PostgresSqlClient, "query"> & { end(): Promise<void> };

/**
 * A Cashu mint accepted for top-ups. `url` is the mint's public HTTPS identity,
 * which appears in tokens and policy. `route` is an optional private transport
 * address for that identity, permitted only for test rails.
 */
export type ServiceMint = Readonly<{ url: string; route?: string }>;

const Keysets = z.object({ keysets: z.array(z.object({ id: z.string(), unit: z.string(), active: z.boolean(), input_fee_ppk: z.number().int().nonnegative().optional() })) });

/**
 * The single funding composition for every deployment: PostgreSQL ledger,
 * receive-only NWC invoices, Cashu swaps at allowlisted mints, and encrypted
 * protected rail material. Development and test deployments select test
 * rails through the same function; they do not use a separate implementation.
 */
export async function createServiceFunding(input: Readonly<{
  pool: ServicePool;
  fundingKey: Uint8Array;
  nwcUri: string;
  nwcPolicy: NwcRelayPolicy;
  settlementPrefix: string;
  mints: readonly ServiceMint[];
  mintPolicyVersion: string;
  allowMintRoutes: boolean;
  deadlineMs?: number;
}>) {
  if (input.fundingKey.byteLength !== 32) throw new Error("SERVICE_FUNDING_KEY_INVALID");
  if (input.mints.length < 1 || input.mints.length > 8 || new Set(input.mints.map((mint) => mint.url)).size !== input.mints.length) throw new Error("SERVICE_MINTS_INVALID");
  const routes = new Map<string, string>();
  for (const mint of input.mints) {
    const identity = new URL(mint.url);
    if (identity.protocol !== "https:" || identity.username || identity.password || identity.search || identity.hash || identity.pathname !== "/") throw new Error("SERVICE_MINT_INVALID");
    if (mint.route !== undefined) {
      if (!input.allowMintRoutes) throw new Error("SERVICE_MINT_ROUTE_DENIED");
      const route = new URL(mint.route);
      if (!["http:", "https:"].includes(route.protocol) || route.username || route.password || route.search || route.hash || route.pathname !== "/") throw new Error("SERVICE_MINT_ROUTE_INVALID");
      routes.set(identity.origin, route.origin);
    }
  }
  const transport = (origin: string) => routes.get(origin) ?? origin;
  const mints = await Promise.all(input.mints.map(async (mint) => {
    const response = await fetch(`${transport(new URL(mint.url).origin)}/v1/keysets`, { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("SERVICE_MINT_KEYSETS_UNAVAILABLE");
    const active = Keysets.parse(await response.json()).keysets.filter((keyset) => keyset.active && keyset.unit === "sat");
    if (active.length === 0) throw new Error("SERVICE_MINT_ACTIVE_SAT_KEYSET_REQUIRED");
    return { url: new URL(mint.url).origin, unit: "sat" as const, keysetIds: active.map((keyset) => keyset.id), maxInputFeePpk: Math.max(...active.map((keyset) => keyset.input_fee_ppk ?? 0)), requireDleq: true, proofConditions: ["none"] };
  }));
  const policies = new CashuMintPolicyRegistry({ version: input.mintPolicyVersion, activeFrom: "2026-01-01T00:00:00.000Z", activeUntil: null, mints });
  // Only allowlisted mint origins are reachable; routed test mints keep their
  // public HTTPS identity in tokens and policy.
  const allowed = new Set(mints.map((mint) => mint.url));
  const request: RequestFn = async <T>(options: RequestOptions): Promise<T> => {
    const source = new URL(options.endpoint);
    if (!allowed.has(source.origin) || source.username || source.password || source.hash) throw new Error("SERVICE_CASHU_ROUTE_DENIED");
    let response: Response;
    try {
      response = await fetch(`${transport(source.origin)}${source.pathname}${source.search}`, {
        method: options.method ?? (options.requestBody ? "POST" : "GET"),
        headers: { "content-type": "application/json" },
        ...(options.requestBody ? { body: JSONInt.stringify(options.requestBody) } : {}),
        signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(options.signal ? [options.signal] : [])]), redirect: "error",
      });
    } catch { throw new NetworkError("Mint request failed"); }
    const body = JSONInt.parse(await response.text()) as { code?: number };
    if (!response.ok) {
      if (typeof body.code === "number") throw new MintOperationError(body.code, "Mint rejected request");
      throw new HttpResponseError("Mint request failed", response.status);
    }
    return body as T;
  };
  const database = new PostgresFundingDatabase(input.pool, { deadlineMs: input.deadlineMs ?? 5_000 });
  const funding = new FundingService(database.funding);
  const vault = new ProtectedRailMaterialVault({ key: new Uint8Array(input.fundingKey), repository: database.protectedMaterials });
  return {
    pool: input.pool, database, funding, vault, policies, routes,
    lightning: new LightningTopUpCoordinator({ funding, vault, repository: database.lightning, receiver: new NwcInvoiceReceiver(input.nwcUri, { policy: input.nwcPolicy, referencePrefix: input.settlementPrefix }), providerTimeoutMs: 20_000 }),
    cashu: new CashuTopUpCoordinator({ funding, vault, repository: database.cashu, policies, provider: new CashuTsSettlementAdapter({ request }), providerTimeoutMs: 20_000 }),
    close: () => input.pool.end(),
  };
}

export type ServiceFunding = Awaited<ReturnType<typeof createServiceFunding>>;
