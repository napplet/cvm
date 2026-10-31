import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { PostgresSqlClient, PostgresSqlPool } from "../persistence/postgres-sql-funding-store";

const PrivateHost = z.string().min(1).max(253).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/u);
const SecretPath = z.string().min(1).refine(value => value.startsWith("/"), "secret path must be absolute");

/** Immutable controller binding.  It deliberately has no connection string: the
 * password is read only by `open`, after the caller has verified authority. */
export const NonGooglePostgresReferenceSchema = z.object({
  host: PrivateHost,
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1).max(63),
  user: z.string().min(1).max(63),
  passwordPath: SecretPath,
  ssl: z.boolean(),
}).strict();
export type NonGooglePostgresReference = z.infer<typeof NonGooglePostgresReferenceSchema>;

export type NonGooglePostgresPool = PostgresSqlPool & Readonly<{ end(): Promise<void> }>;
export type NonGooglePostgresPoolFactory = Readonly<{
  open(reference: NonGooglePostgresReference, password: string): Promise<NonGooglePostgresPool>;
}>;

/** pg's runtime import is deliberately deferred: constructor-only composition
 * neither connects to PostgreSQL nor loads a credential. */
export function createNodePgPoolFactory(): NonGooglePostgresPoolFactory {
  return Object.freeze({
    async open(reference, password) {
      const pg = await import("pg");
      const pool = new pg.Pool({
        host: reference.host,
        port: reference.port,
        database: reference.database,
        user: reference.user,
        password,
        ssl: reference.ssl ? { rejectUnauthorized: true } : undefined,
        max: 4,
        application_name: "napplet-non-google-core",
      });
      return Object.freeze({
        async connect(): Promise<PostgresSqlClient> {
          const client = await pool.connect();
          return Object.freeze({
            async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
              const result = await client.query<Row>(text, values === undefined ? undefined : [...values]);
              return Object.freeze({ rows: result.rows });
            },
            release(error?: Error) { client.release(error); },
          });
        },
        end: () => pool.end(),
      });
    },
  });
}

/** A restricted homelab PG17 pool.  This is intentionally separate from the
 * Cloud-SQL-shaped production pool and does no I/O until `open` is called. */
export class NonGooglePostgresDriver {
  readonly reference: NonGooglePostgresReference;
  constructor(
    reference: NonGooglePostgresReference,
    private readonly poolFactory: NonGooglePostgresPoolFactory = createNodePgPoolFactory(),
    private readonly readSecret: (path: string) => Promise<string> = path => readFile(path, "utf8"),
  ) {
    this.reference = Object.freeze(NonGooglePostgresReferenceSchema.parse(reference));
    Object.freeze(this);
  }

  async open(): Promise<NonGooglePostgresPool> {
    const password = (await this.readSecret(this.reference.passwordPath)).trim();
    if (password.length === 0) throw new Error("NON_GOOGLE_POSTGRES_SECRET_EMPTY");
    try { return await this.poolFactory.open(this.reference, password); }
    finally { password.replace(/./gu, "0"); }
  }
}
