/**
 * `@kobai/plugin-price-log` — a deliberately trivial Plugin.
 *
 * It owns one table and offers one Step, and does nothing else. It exists to prove the
 * mechanism a Plugin uses, not to be useful: installing it as an ordinary npm dependency
 * changes nothing. Its table appears only once a Project wires the migration set below into
 * its `kobai.config.ts`, and its Step runs only once that same file puts it into a Workflow
 * (ADR-0017). Two exports, two deliberate decisions by the Project, and no load order in
 * sight.
 */
export { type PriceLogEntryRow, priceLogEntry } from "./db/schema.ts";
export { priceLogMigrationSet } from "./migration-set.ts";
export { recordPriceResolution } from "./record-price-resolution.ts";
