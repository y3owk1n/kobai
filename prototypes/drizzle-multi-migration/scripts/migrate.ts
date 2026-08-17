// PROTOTYPE. Applies ONE package's migration set. This is what Core, or a Plugin, would
// run for itself — deliberately with no knowledge of any other package.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const pkg = process.argv[2];
if (!pkg) throw new Error("usage: migrate.ts <package-dir>");

const migrationsTable = `__drizzle_migrations_${pkg.replace(/-/g, "_")}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

await migrate(db, {
  migrationsFolder: `./packages/${pkg}/migrations`,
  migrationsTable,
});

console.log(`  applied ${pkg}  →  tracking table ${migrationsTable}`);
await pool.end();
