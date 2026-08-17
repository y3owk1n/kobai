import type { Database } from "../db/client.ts";
import { store } from "../db/schema.ts";

/** The Store as the API reports it. There is no identifier, because there is only one. */
export type Store = {
  readonly name: string;
  readonly defaultCurrency: string;
  readonly metadata: Record<string, unknown>;
};

/**
 * Reads the Store.
 *
 * Note what is absent: there is no `where` clause and no argument to scope by, because
 * there is nothing to scope by. One deployment serves exactly one Store (ADR-0005). A
 * future reader tempted to add a parameter here should read that ADR first — a scoping key
 * on this function is the first move of a multi-tenancy retrofit.
 */
export async function readStore(db: Database): Promise<Store | undefined> {
  const [row] = await db
    .select({
      name: store.name,
      defaultCurrency: store.defaultCurrency,
      metadata: store.metadata,
    })
    .from(store)
    .limit(1);
  return row;
}
