import { spyOn } from "bun:test";
import type { PostgresSqlClient, PostgresSqlPool } from "../../src/persistence/postgres-sql-funding-store";

/** Unit-test SQL responses use Bun's mock boundary, rather than claiming a
 * concrete row implementation satisfies every caller-selected generic row. */
export function scriptedSqlPool(handler: (text: string, values?: readonly unknown[]) => Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>): PostgresSqlPool {
  const scripted: PostgresSqlClient = { async query() { return { rows: [] }; }, release() {} };
  const response = spyOn(scripted, "query");
  const client: PostgresSqlClient = {
    async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      response.mockResolvedValueOnce(await handler(text, values));
      return scripted.query<Row>(text, values);
    },
    release() {},
  };
  return { async connect() { return client; } };
}
