import type { FulfilmentStrategy } from "@kobai/core";

/**
 * The Fulfilment Strategy this Plugin **offers** — ADR-0014's three questions, answered for a
 * thing that is made after it is bought.
 *
 * Offering is the whole of what it does. Importing this module registers nothing: a Variant may
 * point at it only once a Project has wired it in `kobai.config.ts`, under whatever name that
 * Project's Variants use (ADR-0017, ADR-0052):
 *
 * ```ts
 * fulfilment: { strategies: { "made-to-order": madeToOrder } },
 * ```
 *
 * **It has no name of its own, deliberately** — the key above is the name, exactly as a
 * replaced Workflow Step is named by the slot it fills. So two Plugins that both think of
 * theirs as `rental` can be wired side by side, and the name a Variant points at is visible in
 * the one file that exists to show it.
 *
 * The three answers:
 *
 * - **`requiresShipping: true`** — a print job is a physical thing and goes somewhere. Nothing
 *   in Core reads this yet; it is snapshotted onto every Fulfilment from the first Order so
 *   that shipping, when it is built, changes no Order's meaning.
 * - **`tracksInventory: false`** — this is the load-bearing one. Nothing is on a shelf to take
 *   off it, so `hold-reservations` claims nothing for such a line and it needs no Inventory row
 *   to be sellable. A Merchant who counted it anyway (it used to be a stocked poster, say) has
 *   not made it scarce: the Strategy is the answer and a row is only ever how many.
 * - **`hasLeadTime: true`** — there is an interval between Capture and delivery. That is all it
 *   says, because **Capacity is out of scope** (ADR-0012 makes the calendar its own spec and
 *   calls it the single largest addition, so a flat integer here would contradict it in
 *   writing). How long the interval is, and what a shorter one costs, belong to the Step beside
 *   this one — which reads them from data Core has never modelled rather than from anything
 *   this answer carries.
 *
 * It ignores the Variant it is handed, which is a Strategy's right: every Variant a Store makes
 * to order is made to order. What a Variant's own `metadata` is *for* — a per-Variant lead time,
 * a per-Variant rate — is what a Store with real terms would read here, and this Plugin
 * deliberately has none: it is thin on purpose, the way `@kobai/plugin-price-log` is.
 */
export const madeToOrder: FulfilmentStrategy = {
  answersFor: () => ({
    requiresShipping: true,
    tracksInventory: false,
    hasLeadTime: true,
  }),
};
