/**
 * `@kobai/plugin-price-log` — a deliberately trivial Plugin.
 *
 * It owns one table, offers one Step and offers one Subscriber, and does nothing else. It
 * exists to prove the mechanism a Plugin uses, not to be useful: installing it as an ordinary
 * npm dependency changes nothing. Its table appears only once a Project wires the migration set
 * below into its `kobai.config.ts`; its Step runs only once that same file puts it into a
 * Workflow; and its Subscriber hears nothing until that file names it against an Event
 * (ADR-0017, ADR-0085). Three exports a Project may wire, three deliberate decisions by the
 * Project, and no load order in sight.
 *
 * **The Step and the Subscriber are the two halves of the offer-and-wire rule**, and they are
 * here together so a reader can see the difference: a Step is handed a Workflow context and
 * decides something, and a Subscriber is handed a payload and nothing else and decides nothing.
 * The second is the sharper case for the rule, because it has no type check to fall back on —
 * see `log-dispatches.ts`.
 */
export { type PriceLogEntryRow, priceLogEntry } from "./db/schema.ts";
export {
  type DispatchLog,
  type DispatchLogEntry,
  dispatchLog,
} from "./log-dispatches.ts";
export { priceLogMigrationSet } from "./migration-set.ts";
export { recordPriceResolution } from "./record-price-resolution.ts";
