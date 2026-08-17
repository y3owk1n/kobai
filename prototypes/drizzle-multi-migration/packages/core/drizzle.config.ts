// PROTOTYPE. Core's own drizzle config: own schema, own out folder, own tracking table.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/core/schema.ts",
  out: "./packages/core/migrations",
  dbCredentials: { url: process.env.DATABASE_URL! },
  migrations: { table: "__drizzle_migrations_core", schema: "public" },
  // Check E: does this keep `push` from touching tables Core doesn't own?
  tablesFilter: ["core_*"],
});
