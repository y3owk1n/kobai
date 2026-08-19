import { quoteIdentifier } from "../db/identifier.ts";
import { MIGRATIONS_TABLE_STEM } from "../migrations/set.ts";

/**
 * The second test seam: what the database *is*, rather than what it answers.
 *
 * The dominant seam in kobai is the public HTTP API, and everything reachable from it is
 * tested there. ADR-0004's rules are not reachable from it. "No foreign key crosses from a
 * Plugin table into a Core table" and "a Plugin has added no column to a Core table" are
 * properties of the schema itself, and the only honest way to check them is to ask Postgres
 * what it is holding.
 *
 * Lifted from the inspector on branch `prototype/drizzle-multi-migration`, including its
 * mistake: the first version of that script queried only the `public` schema and reported
 * "migration tracking tables: (none)" while migrations were demonstrably applying — the
 * tracking tables were in `drizzle` the whole time. So every sweep here covers every
 * non-system schema, and a table is always named with the schema it is in.
 *
 * ```ts
 * await using kobai = await createTestKobai({ migrationSets: [pluginSet] });
 * const schema = inspectSchema(kobai.database);
 *
 * await expect(schema.foreignKeysCrossingInto("core")).resolves.toEqual([]);
 * await expect(schema.tablesOwnedBy("price_log")).resolves.toEqual(["price_log_entry"]);
 * ```
 */

/**
 * Anything that runs one statement and hands back rows. `TestDatabase` satisfies it, on its
 * own connection rather than the application's — which is the point: this asks the database
 * what it is holding, not what kobai believes it put there.
 */
export type SchemaQuery = {
  query<T extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<T[]>;
};

/** A table, always qualified, because kobai puts tracking tables somewhere else on purpose. */
export type TableRef = {
  readonly schema: string;
  readonly name: string;
};

export type ColumnFact = {
  readonly name: string;
  /** `information_schema.columns.data_type`, e.g. `jsonb`, `text`, `timestamp with time zone`. */
  readonly dataType: string;
  readonly isNullable: boolean;
  readonly hasDefault: boolean;
};

export type TriggerFact = {
  readonly name: string;
  /**
   * `pg_get_triggerdef` — the whole `CREATE TRIGGER` statement Postgres would emit, so the
   * timing, the events and the function it calls are all in it. A test that matched only on
   * the name would accept a trigger of the same name that fired on the wrong event or ran
   * something else entirely.
   */
  readonly definition: string;
};

export type ForeignKeyFact = {
  readonly constraint: string;
  readonly from: TableRef;
  readonly to: TableRef;
};

/**
 * One index, with the columns it orders by **in order** — which is the whole reason this is a
 * fact of its own rather than a longer answer from {@link SchemaInspector.indexedColumnsOf}.
 *
 * A keyset page rests on a *composite* index (ADR-0064): `(created_at, id)` supports
 * `order by created_at desc, id desc` and a row comparison against the pair, while an index on
 * `created_at` beside a separate one on `id` supports neither and is indistinguishable from it
 * once the columns are flattened into a set. So the columns arrive as a list and the list keeps
 * its order.
 *
 * **A column carries its sort direction, because the bare name is not enough to know what an
 * index supports.** `pg_get_indexdef` renders a *single* key column without the `DESC` and the
 * `NULLS` placement it renders for the whole index, so `(created_at desc, id desc)` and
 * `(created_at, id)` arrive identically unless they are added back — which would let a caller
 * accept an index for an ordering it cannot serve. They are spelled here exactly as Postgres
 * spells them whole: `DESC` where the column descends, and a `NULLS` clause only where it is
 * not that direction's default. An **expression** index arrives as the expression's text rather
 * than as nothing at all, since an index this cannot describe would otherwise read as an index
 * with no columns. Only the key columns are reported: an `INCLUDE`d payload column is not part
 * of the ordering and would misrepresent one if it were listed beside the ones that are.
 */
export type IndexFact = {
  readonly name: string;
  readonly columns: readonly string[];
  /**
   * Whether it covers only the rows of a `where` clause — which is the other way an index that
   * names the right columns in the right order still does not answer for the whole table.
   */
  readonly isPartial: boolean;
};

export type MigrationTrackingFact = {
  readonly schema: string;
  readonly table: string;
  /** Rows in it — how many of that package's migrations this database has seen. */
  readonly applied: number;
};

export type SchemaInspector = {
  /**
   * Every table in the database, in every non-system schema, migration tracking excluded.
   * The whole picture, so nothing hides in a schema a narrower query forgot to look in.
   */
  tables(): Promise<TableRef[]>;
  /**
   * The tables a package owns, by its table prefix — `core` finds `core_store`. Names only,
   * sorted, because "which tables did this package create" is the question, and the answer
   * for a Plugin that a Project has not wired must be none.
   */
  tablesOwnedBy(prefix: string): Promise<string[]>;
  columnsOf(table: TableRef | string): Promise<ColumnFact[]>;
  /**
   * Every column of every table a package owns, keyed by table name.
   *
   * This is the shape ADR-0004's rule is checked against: take it with a Plugin's set
   * applied and without, and the two must be identical, because a Plugin may not add a
   * column to a Core table.
   */
  columnsOwnedBy(prefix: string): Promise<Record<string, ColumnFact[]>>;
  /**
   * Columns covered by any index on a table, primary keys and unique constraints included.
   * Core's `metadata` must appear in none of them — it is unindexed by design (ADR-0004),
   * and a Plugin that needs an index needs its own table.
   */
  indexedColumnsOf(table: TableRef | string): Promise<string[]>;
  /**
   * Every index on a table, sorted by name, each carrying its key columns **in index order**.
   *
   * The question {@link indexedColumnsOf} cannot be asked: that one flattens every index into
   * one set of column names, which answers "is this column indexed at all" — right for
   * ADR-0004's `metadata`, and unable to tell a composite `(created_at, id)` from two
   * single-column indexes that happen to cover the same two names. A keyset page needs the
   * former and is not helped by the latter (ADR-0064), so the check that a paged list has its
   * index asks here.
   *
   * The primary key's own index is included, because it is an index a query can use like any
   * other and hiding it would make a table's answer disagree with `\d`.
   */
  indexesOf(table: TableRef | string): Promise<IndexFact[]>;
  /**
   * The triggers on a table, sorted by name — the ones somebody declared, not the hidden
   * ones Postgres attaches to enforce a foreign key.
   *
   * Core advances `updated_at` with a trigger rather than an ORM hook (ADR-0037), which
   * makes "does this table have one" a question about the database and not about the
   * TypeScript. It is the guardrail's question: a new Core table carrying the column and
   * missing the trigger is exactly the omission that put this repository here once.
   */
  triggersOf(table: TableRef | string): Promise<TriggerFact[]>;
  /** Every foreign key in the database. */
  foreignKeys(): Promise<ForeignKeyFact[]>;
  /**
   * Foreign keys pointing **into** a package's tables from tables it does not own — the
   * exact thing ADR-0004 forbids. `foreignKeysCrossingInto("core")` returning `[]` is the
   * rule holding: a Plugin references Core rows by ID and never by constraint, which is
   * also why migration sets apply in any order.
   *
   * Core's own foreign keys between its own tables are not crossings and do not appear.
   */
  foreignKeysCrossingInto(prefix: string): Promise<ForeignKeyFact[]>;
  /**
   * Every foreign key pointing at **one table**, from anywhere at all — the table's own
   * package included.
   *
   * The stronger question, and deliberately not the prefix one. ADR-0005 makes the Store a
   * singleton that is never a scoping key, so `foreignKeysTargeting(coreStore)` returning
   * `[]` is single-tenancy holding structurally: nothing can scope by a row nothing
   * references. `foreignKeysCrossingInto("core")` cannot ask it — it excuses a package's
   * references to itself, so a `core_` table growing a `store_id` would read as Core's own
   * business, which is exactly how multi-tenancy would arrive.
   *
   * Pass the ref `tables()` hands back rather than a bare name where it matters: a bare name
   * resolves to `public`, and a sweep aimed at a schema the table is not in finds nothing and
   * says the rule holds.
   */
  foreignKeysTargeting(table: TableRef | string): Promise<ForeignKeyFact[]>;
  /** Every migration tracking table, wherever it lives, with its row count. */
  migrationTracking(): Promise<MigrationTrackingFact[]>;
};

export function inspectSchema(source: SchemaQuery): SchemaInspector {
  /**
   * Every base table there is, in one query, partitioned in TypeScript rather than by two
   * near-identical `like` clauses. Scanning every non-system schema is the point: the
   * prototype's inspector looked only in `public` and concluded that migrations were not
   * being tracked, while the tracking tables sat in `drizzle` the whole time.
   */
  const allBaseTables = async (): Promise<TableRef[]> => {
    const rows = await source.query<{ table_schema: string; table_name: string }>(`
      select table_schema, table_name
      from information_schema.tables
      where table_schema not in ('pg_catalog', 'information_schema')
        and table_type = 'BASE TABLE'
      order by table_schema, table_name
    `);
    return rows.map((row) => ({ schema: row.table_schema, name: row.table_name }));
  };

  /**
   * Matched on the *stem*, not on kobai's `__drizzle_migrations_<pkg>` prefix, so the bare
   * `__drizzle_migrations` that Drizzle falls back to when nobody names a table counts as
   * tracking too. A test asserting which tracking tables exist should see that one arrive
   * rather than mistake it for somebody's domain table (ADR-0030).
   */
  const isTracking = (table: TableRef) => table.name.startsWith(MIGRATIONS_TABLE_STEM);

  const inspector: SchemaInspector = {
    async tables() {
      return (await allBaseTables()).filter((table) => !isTracking(table));
    },

    async tablesOwnedBy(prefix) {
      const all = await inspector.tables();
      return all.filter((table) => owns(prefix, table.name)).map((table) => table.name);
    },

    async columnsOf(table) {
      const ref = resolve(table);
      const rows = await source.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
         where table_schema = $1 and table_name = $2
         order by ordinal_position`,
        [ref.schema, ref.name],
      );
      return rows.map((row) => ({
        name: row.column_name,
        dataType: row.data_type,
        isNullable: row.is_nullable === "YES",
        hasDefault: row.column_default !== null,
      }));
    },

    async columnsOwnedBy(prefix) {
      const everything = await inspector.tables();
      const entries = await Promise.all(
        everything
          .filter((table) => owns(prefix, table.name))
          .map(async (table) => [table.name, await inspector.columnsOf(table)] as const),
      );
      return Object.fromEntries(entries);
    },

    async indexedColumnsOf(table) {
      const ref = resolve(table);
      const rows = await source.query<{ column_name: string }>(
        // information_schema has no view of indexes, only of constraints — an index that is
        // not a constraint would be invisible there. pg_index sees all of them.
        `select distinct attribute.attname as column_name
         from pg_index index_
         join pg_class table_ on table_.oid = index_.indrelid
         join pg_namespace namespace on namespace.oid = table_.relnamespace
         join pg_attribute attribute
           on attribute.attrelid = table_.oid and attribute.attnum = any(index_.indkey)
         where namespace.nspname = $1 and table_.relname = $2
         order by column_name`,
        [ref.schema, ref.name],
      );
      return rows.map((row) => row.column_name);
    },

    async indexesOf(table) {
      const ref = resolve(table);
      const rows = await source.query<{
        index_name: string;
        columns: string[];
        is_partial: boolean;
      }>(
        // `pg_get_indexdef(oid, n, true)` renders the nth **key** column, which is what makes
        // an expression index describable at all: `indkey` holds 0 for one, so a join through
        // `pg_attribute` would drop it and report an index one column short. `indnkeyatts`
        // rather than `indnatts` stops at the last key column, leaving an `INCLUDE`d payload
        // out of an answer that is about ordering.
        //
        // What that per-column form does *not* render is the sort direction, so `indoption`
        // puts it back: bit 0 is `DESC` and bit 1 is `NULLS FIRST`, and a `NULLS` clause is
        // spelled only when it is not the default for the direction — descending defaults to
        // nulls first and ascending to nulls last — which is how Postgres renders the whole
        // index. `indoption` is an `int2vector` and so subscripts from zero.
        `select
           index_class.relname as index_name,
           index_.indpred is not null as is_partial,
           array(
             select pg_get_indexdef(index_.indexrelid, key_position::int, true)
                    || case when sort.flags & 1 = 1 then ' DESC' else '' end
                    || case
                         when (sort.flags & 2 = 2) <> (sort.flags & 1 = 1)
                           then case
                                  when sort.flags & 2 = 2 then ' NULLS FIRST'
                                  else ' NULLS LAST'
                                end
                         else ''
                       end
             from generate_series(1, index_.indnkeyatts) as key_position,
                  lateral (select index_.indoption[key_position - 1] as flags) as sort
           ) as columns
         from pg_index index_
         join pg_class table_ on table_.oid = index_.indrelid
         join pg_class index_class on index_class.oid = index_.indexrelid
         join pg_namespace namespace on namespace.oid = table_.relnamespace
         where namespace.nspname = $1 and table_.relname = $2
         order by index_name`,
        [ref.schema, ref.name],
      );
      return rows.map((row) => ({
        name: row.index_name,
        columns: row.columns,
        isPartial: row.is_partial,
      }));
    },

    async triggersOf(table) {
      const ref = resolve(table);
      const rows = await source.query<{ trigger_name: string; definition: string }>(
        // pg_trigger rather than information_schema.triggers, which reports one row per
        // event and would count `before insert or update` twice. `tgisinternal` is what
        // hides the triggers Postgres creates for a foreign key: they are not anybody's
        // declaration and a test asserting on them should never see them.
        `select
           trigger_.tgname as trigger_name,
           pg_get_triggerdef(trigger_.oid) as definition
         from pg_trigger trigger_
         join pg_class table_ on table_.oid = trigger_.tgrelid
         join pg_namespace namespace on namespace.oid = table_.relnamespace
         where namespace.nspname = $1 and table_.relname = $2
           and not trigger_.tgisinternal
         order by trigger_name`,
        [ref.schema, ref.name],
      );
      return rows.map((row) => ({ name: row.trigger_name, definition: row.definition }));
    },

    async foreignKeys() {
      const rows = await source.query<{
        constraint_name: string;
        from_schema: string;
        from_table: string;
        to_schema: string;
        to_table: string;
      }>(`
        select
          constraint_.conname as constraint_name,
          from_namespace.nspname as from_schema,
          from_table.relname as from_table,
          to_namespace.nspname as to_schema,
          to_table.relname as to_table
        from pg_constraint constraint_
        join pg_class from_table on from_table.oid = constraint_.conrelid
        join pg_namespace from_namespace on from_namespace.oid = from_table.relnamespace
        join pg_class to_table on to_table.oid = constraint_.confrelid
        join pg_namespace to_namespace on to_namespace.oid = to_table.relnamespace
        where constraint_.contype = 'f'
          and from_namespace.nspname not in ('pg_catalog', 'information_schema')
        order by from_namespace.nspname, from_table.relname, constraint_.conname
      `);
      return rows.map((row) => ({
        constraint: row.constraint_name,
        from: { schema: row.from_schema, name: row.from_table },
        to: { schema: row.to_schema, name: row.to_table },
      }));
    },

    async foreignKeysCrossingInto(prefix) {
      const all = await inspector.foreignKeys();
      return all.filter((fk) => owns(prefix, fk.to.name) && !owns(prefix, fk.from.name));
    },

    async foreignKeysTargeting(table) {
      const ref = resolve(table);
      const all = await inspector.foreignKeys();
      return all.filter((fk) => fk.to.schema === ref.schema && fk.to.name === ref.name);
    },

    async migrationTracking() {
      const tracking = (await allBaseTables()).filter(isTracking);

      return Promise.all(
        tracking.map(async (table) => {
          const [count] = await source.query<{ applied: string }>(
            // Identifiers cannot be bound, so they are quoted. They come from
            // information_schema rather than from a caller, but quoting is free.
            `select count(*)::text as applied
             from ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`,
          );
          return {
            schema: table.schema,
            table: table.name,
            applied: Number(count?.applied ?? 0),
          };
        }),
      );
    },
  };

  return inspector;
}

/** A package owns a table when the table carries its prefix and a separating underscore. */
function owns(prefix: string, tableName: string): boolean {
  return tableName.startsWith(`${prefix}_`);
}

function resolve(table: TableRef | string): TableRef {
  return typeof table === "string" ? { schema: "public", name: table } : table;
}
