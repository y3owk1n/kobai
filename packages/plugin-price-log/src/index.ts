/**
 * `@kobai/plugin-price-log` — a deliberately trivial Plugin.
 *
 * It owns one table and does nothing else. It exists to prove the mechanism a Plugin uses,
 * not to be useful: installing it as an ordinary npm dependency changes nothing, and its
 * table appears only once a Project wires the migration set below into its
 * `kobai.config.ts` (ADR-0017).
 */
export { priceLogEntry, type PriceLogEntryRow } from "./db/schema.ts";
export { priceLogMigrationSet } from "./migration-set.ts";
