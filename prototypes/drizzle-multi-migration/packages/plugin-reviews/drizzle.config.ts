// PROTOTYPE. The reviews plugin's config. Note it never mentions Core.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/plugin-reviews/schema.ts",
  out: "./packages/plugin-reviews/migrations",
  dbCredentials: { url: process.env.DATABASE_URL! },
  migrations: { table: "__drizzle_migrations_plugin_reviews", schema: "public" },
  tablesFilter: ["reviews_*"],
});
