/**
 * `@kobai/plugin-made-to-order` — made-to-order at its thinnest, as a Plugin.
 *
 * ADR-0014 named this the proof of the Fulfilment Strategy interface: *if made-to-order cannot
 * be expressed as a strategy Plugin, the strategy interface is wrong.* So this package exists
 * to be that expression and nothing more — one Strategy answering the three questions, one Step
 * that turns a Lead Time into an Adjustment, one table of its own, and no feature. It is the
 * same discipline `@kobai/plugin-price-log` applies to the Workflow surface, pointed at the
 * strategy surface instead.
 *
 * **Installing it changes nothing.** Every export below is inert until a Project names it in
 * `kobai.config.ts` (ADR-0017) — the migration set for the table, the Strategy for the name a
 * Variant may point at, the Step for the surcharge:
 *
 * ```ts
 * migrationSets: [madeToOrderMigrationSet],
 * fulfilment: { strategies: { "made-to-order": madeToOrder } },
 * workflows: { "place-order": { steps: { "apply-adjustments": leadTimeSurcharge } } },
 * ```
 *
 * Three lines, three deliberate decisions by the Project, and no load order in sight.
 *
 * What is deliberately **not** here: Capacity, a calendar, and any claim that a lead time can
 * be met. ADR-0012 makes that its own spec, and the Strategy's answer is honest without one —
 * it says a Lead Time exists, and the Step says what a shorter one costs.
 */
export type { MadeToOrderSurchargeRow } from "./db/schema.ts";
export { madeToOrderSurcharge } from "./db/schema.ts";
export {
  LEAD_TIME_DAYS_KEY,
  LEAD_TIME_SURCHARGE_CODE,
  leadTimeSurcharge,
  MADE_TO_ORDER_TERMS,
} from "./lead-time-surcharge.ts";
export { madeToOrderMigrationSet } from "./migration-set.ts";
export { madeToOrder } from "./strategy.ts";
