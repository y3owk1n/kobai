/**
 * `@kobai/core/testing` — the test harness, shipped rather than kept private, because a
 * Plugin author needs the same seam Core tests through.
 */
export {
  createTestDatabase,
  type TestDatabase,
  testPostgresUrl,
} from "./database.ts";
export {
  type ColumnFact,
  type ForeignKeyFact,
  inspectSchema,
  type MigrationTrackingFact,
  type SchemaInspector,
  type SchemaQuery,
  type TableRef,
} from "./schema.ts";
export {
  createTestKobai,
  silentLogger,
  type TestKobai,
  type TestKobaiOptions,
} from "./kobai.ts";
