import { describe, expect, it } from "vitest";
import {
  createTestApiKey,
  createTestKobai,
  inspectSchema,
  signInTestMerchant,
  type TestDatabase,
} from "../testing/index.ts";
import { quoteIdentifier } from "./identifier.ts";

/**
 * `updated_at`, and the promise that it means what it says.
 *
 * Every assertion here works by **moving a row and watching the value follow**. A column
 * that defaults to `now()` and is never advanced looks correct in every schema dump and is
 * wrong on every row that has ever been written twice, so inspecting the declaration proves
 * nothing at all — only an update does.
 */

/** What Postgres is holding, read on its own connection rather than through kobai. */
async function updatedAtOf(
  database: TestDatabase,
  table: string,
  id: string,
): Promise<Date> {
  const rows = await database.query<{ updated_at: Date }>(
    // Quoted, like every identifier this repository interpolates. The callers here all pass
    // literals, but quoting is free and the habit is what survives the next caller.
    `select updated_at from ${quoteIdentifier(table)} where id = $1`,
    [id],
  );
  const value = rows[0]?.updated_at;
  if (value === undefined) throw new Error(`no row ${id} in ${table}`);
  return value;
}

describe("updated_at", () => {
  it("advances when Core updates a row through its own API", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const key = await createTestApiKey(kobai, merchant);

    const before = await updatedAtOf(kobai.database, "core_api_key", key.id);

    // Revoking is the one update Core's whole HTTP surface performs today, which is itself
    // the argument this ticket turns on: nearly every write that will ever land on a Core
    // row comes from somewhere else.
    const revoked = await kobai.request(`/admin/api-keys/${key.id}`, {
      method: "DELETE",
      headers: merchant.headers,
    });
    expect(revoked.status).toBe(204);

    const after = await updatedAtOf(kobai.database, "core_api_key", key.id);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  /**
   * The case the mechanism was chosen for, and the one an ORM hook cannot serve.
   *
   * A Project owns its repository and its migrations and may write Core's tables however it
   * likes; a Plugin holds a connection to the same database. Neither is obliged to go
   * through Drizzle, and this write deliberately does not — it is issued on the test
   * database's own connection, which is as far outside Core's query builder as a write can
   * get while still landing on the row.
   */
  it("advances for a writer that never goes through Core", async () => {
    await using kobai = await createTestKobai();
    const [seeded] = await kobai.database.query<{ id: string; updated_at: Date }>(
      "select id, updated_at from core_role order by created_at limit 1",
    );
    if (seeded === undefined) throw new Error("the owner Role should have been seeded");

    await kobai.database.query("update core_role set metadata = $1 where id = $2", [
      JSON.stringify({ renamedBy: "a Project, in SQL Core never saw" }),
      seeded.id,
    ]);

    const after = await updatedAtOf(kobai.database, "core_role", seeded.id);
    expect(after.getTime()).toBeGreaterThan(seeded.updated_at.getTime());
  });

  /**
   * The database has the last word, so a writer cannot hand `updated_at` a value of its own —
   * by mistake, by copying a row, or by restoring one. This also makes the column's meaning
   * independent of who wrote it, which is the property a consumer is actually trusting.
   */
  it("overrides a writer that sets the column itself", async () => {
    await using kobai = await createTestKobai();

    const [row] = await kobai.database.query<{ updated_at: Date }>(
      `update core_store
         set updated_at = timestamptz '1999-12-31 23:59:59+00'
       where singleton
       returning updated_at`,
    );

    expect(row?.updated_at.getUTCFullYear()).toBe(new Date().getUTCFullYear());
  });

  /** The other half: a trigger that advanced `created_at` too would be its own silent bug. */
  it("leaves created_at where it was", async () => {
    await using kobai = await createTestKobai();
    const [before] = await kobai.database.query<{ created_at: Date }>(
      "select created_at from core_store where singleton",
    );

    await kobai.database.query("update core_store set name = 'renamed' where singleton");

    const [after] = await kobai.database.query<{ created_at: Date }>(
      "select created_at from core_store where singleton",
    );
    expect(after?.created_at.getTime()).toBe(before?.created_at.getTime());
  });
});

/**
 * The guardrail, and the thing that keeps this fixed.
 *
 * The migration attaches the trigger to every Core table carrying `updated_at` **as the
 * database stood when it ran**, and a table created afterwards gets nothing. Nothing in
 * Drizzle, in drizzle-kit or in Postgres will say so: a missing trigger is invisible in a
 * schema dump, in a generated migration and in every response body. So the omission is
 * caught here, by asking Postgres the same question the migration asked and requiring the
 * two answers to agree.
 *
 * A new Core table therefore turns this red on the commit that adds it, naming itself, and
 * the fix is one `--custom` migration.
 */
describe("the updated_at guardrail", () => {
  /**
   * What the trigger has to be, not merely what it has to be called. A trigger of the right
   * name that fired after the write, or on insert, or ran something else, would advance
   * nothing and satisfy a name check — the same "looks right, is wrong" shape as the column
   * this guards.
   */
  const ADVANCES_UPDATED_AT = /before update .*for each row.*core_set_updated_at\(\)/is;

  /**
   * Every Core table that carries `updated_at` and has nothing advancing it. The rule, asked
   * of Postgres rather than of the Drizzle declaration that produced it — a table can arrive
   * from a `--custom` migration and never appear in `schema.ts` at all.
   *
   * Tables are carried as the qualified refs `tables()` hands back rather than as bare
   * names, because a bare name resolves to `public` and Core's tables live in
   * `current_schema()` — on a deployment where those differ, a name-based sweep would find
   * no columns on any table, skip every one of them, and report nothing missing.
   */
  async function coreTablesWithoutTheTrigger(database: TestDatabase): Promise<string[]> {
    const schema = inspectSchema(database);
    const missing: string[] = [];

    for (const table of await schema.tables()) {
      if (!table.name.startsWith("core_")) continue;

      const columns = await schema.columnsOf(table);
      if (!columns.some((column) => column.name === "updated_at")) continue;

      const trigger = (await schema.triggersOf(table)).find(
        (candidate) => candidate.name === `${table.name}_set_updated_at`,
      );
      if (trigger === undefined || !ADVANCES_UPDATED_AT.test(trigger.definition)) {
        missing.push(table.name);
      }
    }

    return missing;
  }

  it("finds nothing missing on a migrated database", async () => {
    await using kobai = await createTestKobai();
    const missing = await coreTablesWithoutTheTrigger(kobai.database);

    expect(
      missing,
      `nothing advances updated_at on: ${missing.join(", ")}. Attach core_set_updated_at in a --custom migration, as migrations/0009_updated_at_triggers.sql does.`,
    ).toEqual([]);
  });

  /**
   * And the check above is not vacuous, which is the part worth proving: a guardrail that
   * would say "nothing missing" whatever the schema held is the same silent-correctness
   * failure as the column it guards.
   *
   * The table is created here rather than in a migration precisely because that is what the
   * omission looks like — a Core table that exists, carries the column, and was never given
   * the trigger.
   */
  it("names a Core table that arrived without one, and one wearing the name only", async () => {
    await using kobai = await createTestKobai();

    await kobai.database.query(`
      create table core_forgotten (
        id uuid primary key default gen_random_uuid(),
        updated_at timestamp with time zone not null default now()
      )
    `);
    // The subtler omission: the right name, on the right table, firing too late to change
    // anything — an `after` trigger's assignment to NEW is discarded. Passing a name check
    // and advancing nothing is the failure mode this whole ticket is about.
    await kobai.database.query(`
      create table core_mistimed (
        id uuid primary key default gen_random_uuid(),
        updated_at timestamp with time zone not null default now()
      )
    `);
    await kobai.database.query(`
      create trigger core_mistimed_set_updated_at
        after update on core_mistimed
        for each row execute function core_set_updated_at()
    `);

    await expect(coreTablesWithoutTheTrigger(kobai.database)).resolves.toEqual([
      "core_forgotten",
      "core_mistimed",
    ]);
  });

  it("leaves a Core table without the column alone", async () => {
    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);

    // A Session has no `updated_at` — it is a transient claim that is deleted rather than
    // edited — so it must have no trigger either. A sweep that attached one to everything
    // would pass the test above and be wrong here.
    expect(await schema.columnsOf("core_session")).not.toContainEqual(
      expect.objectContaining({ name: "updated_at" }),
    );
    await expect(schema.triggersOf("core_session")).resolves.toEqual([]);
  });
});
