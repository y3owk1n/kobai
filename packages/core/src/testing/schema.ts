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

export type ForeignKeyFact = {
  readonly constraint: string;
  readonly from: TableRef;
  readonly to: TableRef;
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
