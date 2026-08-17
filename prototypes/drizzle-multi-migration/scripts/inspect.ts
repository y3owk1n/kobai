// PROTOTYPE. Prints what is actually in the database, so every claim in FINDINGS.md is
// something observed rather than something assumed.
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Scan EVERY non-system schema. Drizzle's programmatic migrator defaults migrationsSchema
// to "drizzle", not "public" — looking only at public reports zero tracking tables while
// migrations are demonstrably applying.
const { rows: tables } = await pool.query<{
  table_schema: string;
  table_name: string;
}>(`
  select table_schema, table_name from information_schema.tables
  where table_schema not in ('pg_catalog','information_schema') and table_type = 'BASE TABLE'
  order by table_schema, table_name
`);

const qualify = (t: { table_schema: string; table_name: string }) =>
  `${t.table_schema}.${t.table_name}`;
const domain = tables.filter((t) => !t.table_name.includes("drizzle_migrations"));
const tracking = tables.filter((t) => t.table_name.includes("drizzle_migrations"));

console.log("  domain tables:");
if (domain.length === 0) console.log("    (none)");
for (const t of domain) {
  const { rows: cols } = await pool.query<{ column_name: string }>(
    `select column_name from information_schema.columns
     where table_schema=$1 and table_name=$2 order by ordinal_position`,
    [t.table_schema, t.table_name],
  );
  console.log(
    `    ${qualify(t).padEnd(26)} (${cols.map((c) => c.column_name).join(", ")})`,
  );
}

console.log("  migration tracking tables:");
if (tracking.length === 0) console.log("    (none)");
for (const t of tracking) {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from "${t.table_schema}"."${t.table_name}"`,
  );
  console.log(`    ${qualify(t).padEnd(48)} ${rows[0].n} migration(s) recorded`);
}

// ADR-0004's rule, checked rather than asserted: no FK may point from a plugin table
// into a core table.
const { rows: fks } = await pool.query<{ src: string; tgt: string }>(`
  select tc.table_name as src, ccu.table_name as tgt
  from information_schema.table_constraints tc
  join information_schema.constraint_column_usage ccu using (constraint_name, constraint_schema)
  where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
`);
console.log("  foreign keys:");
if (fks.length === 0) console.log("    (none)");
for (const fk of fks) {
  const crossesBoundary =
    !fk.src.startsWith("core_") && fk.tgt.startsWith("core_");
  console.log(
    `    ${fk.src} → ${fk.tgt}${crossesBoundary ? "   ← ADR-0004 VIOLATION" : ""}`,
  );
}

await pool.end();
