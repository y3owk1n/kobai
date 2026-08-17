import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

export type Database = NodePgDatabase<typeof schema>;

/** The handle Drizzle passes a `db.transaction(…)` callback. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Whatever a query can be issued against — the pool, or one open transaction.
 *
 * A read function that takes this can be called from inside a write's transaction as well as
 * on its own, which is what lets a mutation answer with the state its own transaction left
 * rather than with a fresh read taken after the lock was released.
 */
export type Queryable = Database | Transaction;

export type DatabaseHandle = {
  readonly db: Database;
  readonly pool: pg.Pool;
  close(): Promise<void>;
};

export function createDatabaseHandle(connectionString: string): DatabaseHandle {
  const pool = new pg.Pool({ connectionString });
  // Without this, a connection error raised while the pool is idle is an unhandled
  // 'error' event and takes the process down with an unhelpful stack.
  pool.on("error", () => {});
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}
