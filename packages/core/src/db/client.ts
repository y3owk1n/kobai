import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

export type Database = NodePgDatabase<typeof schema>;

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
