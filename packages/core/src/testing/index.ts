/**
 * `@kobai/core/testing` — the test harness, shipped rather than kept private, because a
 * Plugin author needs the same seam Core tests through.
 */
export { createTestApiKey, type TestApiKey } from "./api-key.ts";
export {
  seedTestCart,
  type TestCart,
  type TestCartLineItem,
  type TestCartLineSpec,
  type TestCartOptions,
} from "./cart.ts";
export {
  seedTestCatalog,
  type TestCatalog,
  type TestCatalogOptions,
  type TestCatalogPrice,
  type TestCatalogVariant,
  type TestVariantSpec,
} from "./catalog.ts";
export {
  createTestDatabase,
  type TestDatabase,
  testPostgresUrl,
} from "./database.ts";
export {
  createTestKobai,
  silentLogger,
  type TestKobai,
  type TestKobaiOptions,
} from "./kobai.ts";
export {
  seedTestMerchant,
  sessionOf,
  signInTestMerchant,
  TEST_MERCHANT,
  type TestCredentials,
  type TestSession,
} from "./merchant.ts";
export {
  appliedMigrations,
  declaredMigrations,
  migrationSetUpTo,
  type PartialMigrationSet,
} from "./migrations.ts";
export { testPaymentProvider } from "./payments.ts";
export {
  type ColumnFact,
  type ForeignKeyFact,
  inspectSchema,
  type MigrationTrackingFact,
  type SchemaInspector,
  type SchemaQuery,
  type TableRef,
  type TriggerFact,
} from "./schema.ts";
