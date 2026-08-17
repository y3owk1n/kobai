// PROTOTYPE. Identical to drizzle.config.ts but with NO tablesFilter.
// Check E's control case: what does `push` propose when it can see every table?
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/core/schema.ts",
  out: "./packages/core/migrations",
  dbCredentials: { url: process.env.DATABASE_URL! },
  migrations: { table: "__drizzle_migrations_core", schema: "public" },
});
