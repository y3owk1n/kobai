// PROTOTYPE. The wishlist plugin's config.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/plugin-wishlist/schema.ts",
  out: "./packages/plugin-wishlist/migrations",
  dbCredentials: { url: process.env.DATABASE_URL! },
  migrations: { table: "__drizzle_migrations_plugin_wishlist", schema: "public" },
  tablesFilter: ["wishlist_*"],
});
