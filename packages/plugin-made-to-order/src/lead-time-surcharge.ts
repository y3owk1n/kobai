import {
  type AdjustedLine,
  type AdjustedLines,
  type Adjustment,
  defineStep,
  type PricedLine,
  type PricedLines,
  StepFailure,
} from "@kobai/core";
import { inArray } from "drizzle-orm";
import { madeToOrderSurcharge } from "./db/schema.ts";

/**
 * The Step this Plugin **offers**: a Lead Time costs money, and it costs it as an Adjustment.
 *
 * ADR-0022 settled the shape before anything could be built against a worse one — a Lead Time
 * surcharge is **an Adjustment**, its own line on the Order, never a number folded into what a
 * Variant costs. So this Step declares one and Core writes it; nothing here touches a
 * `unitAmount`, and the Order that comes out says both what the goods cost and what the hurry
 * cost.
 *
 * Wired by a Project, in the one file that shows every customisation (ADR-0017):
 *
 * ```ts
 * workflows: { "place-order": { steps: { "apply-adjustments": leadTimeSurcharge } } },
 * ```
 *
 * It **owns** the slot rather than watching it, because it decides something: Core's own
 * `apply-adjustments` attaches no Adjustment at all, so there is nothing here to compose with
 * and replacement is the honest spelling. A deployment that grows a *second* rule about
 * Adjustments should reach for `after: { "apply-adjustments": [...] }` for the second one,
 * which stacks — that is what an inserted Step is for, and it takes and gives the same type so
 * it cannot drop what this one added.
 *
 * ## Where the Lead Time comes from, and why that is the point
 *
 * From {@link WorkflowContext.metadata} — the **open** half of the context (ADR-0013). Core
 * writes it and reads no key out of it: whatever the caller sent that Core does not model
 * arrives verbatim, which is what lets a Plugin price on an input Core has never heard of
 * without Core changing to let it. This Step is that promise carried through to a row: a
 * storefront asks for delivery sooner than usual, and a figure Core cannot compute lands on
 * the Order.
 *
 * Today the open context is filled from the request's **query string** alone —
 * `openMetadata(url)` is `Object.fromEntries(url.searchParams)` — so a storefront asks like
 * this:
 *
 * ```
 * POST /store/orders?leadTimeDays=3
 * ```
 *
 * That is a limitation of the transport rather than of this Plugin (filed as #121: a JSON body
 * would be the natural place for it), and it is why every value here arrives as a **string**.
 * This Step reads whatever arrives and says so when it cannot: a lead time it does not
 * understand is refused rather than ignored, because ignoring it would deliver late and charge
 * nothing.
 *
 * ## The terms
 *
 * {@link MADE_TO_ORDER_TERMS}, and they are constants because this Plugin is deliberately thin
 * — the same discipline `@kobai/plugin-price-log` keeps. A Store with real terms holds them per
 * Variant in a table of its own, which is exactly the kind of table a Plugin owns (ADR-0004),
 * and reads a Variant's own `metadata` for the rest. **No calendar is implied and none exists**:
 * Capacity is its own spec (ADR-0012), so this says what a shorter interval costs and never
 * that the Store can achieve it.
 */

/**
 * The key this Plugin reads out of the open context, and the whole of what it asks a caller
 * for.
 *
 * Its name is the Plugin's, not Core's — Core has never heard of it, which is the point — so it
 * is exported: a storefront spells it in a query string, and a test should not have to guess.
 */
export const LEAD_TIME_DAYS_KEY = "leadTimeDays";

/**
 * What this Plugin charges for hurry.
 *
 * Exported so a Project can read what it wired and a test can assert against the terms rather
 * than against a number copied out of this file. Per **day saved** and per **unit**, because
 * rushing ten of something is ten things rushed.
 */
export const MADE_TO_ORDER_TERMS = {
  /** The interval this Store treats as ordinary. Asking for this or more costs nothing extra. */
  standardLeadTimeDays: 10,
  /**
   * Minor units per day saved, per unit ordered.
   *
   * Minor units of whatever the Order is priced in, which is a real limitation of a Plugin
   * this thin: a Store selling in two currencies wants two rates, and would hold them in its
   * own table rather than here.
   */
  surchargePerDaySaved: 500,
} as const;

/** The code the Adjustment carries — machine-readable, and this Plugin's to choose. */
export const LEAD_TIME_SURCHARGE_CODE = "lead-time-surcharge";

/**
 * What this Step wrote, for the run that wrote it.
 *
 * Core hands a compensation **the very value** its `run` was given (ADR-0036), so that value is
 * the key: no bookkeeping crosses between runs, and a failure now can only ever undo what this
 * run did. Weak, so a run that succeeds leaves nothing behind to collect; and outside the Step
 * rather than on the value it passes along, because that value belongs to the Workflow.
 *
 * A stack, for the reason `@kobai/plugin-price-log` keeps one: nothing stops a Project wiring
 * this Step in twice, and Core unwinds in reverse, so each compensation takes back the rows its
 * own `run` put on top.
 */
const written = new WeakMap<PricedLines, string[][]>();

export const leadTimeSurcharge = defineStep(
  "lead-time-surcharge",

  async (input: PricedLines, context): Promise<AdjustedLines> => {
    const requested = requestedLeadTimeDays(context.metadata);
    // Nobody is in a hurry, which is every Cart in every Store that does not send this key —
    // so this Step costs such a Cart one comparison and leaves it exactly as Core's own
    // `apply-adjustments` would have.
    if (requested === undefined) return unadjusted(input);

    const daysSaved = Math.max(0, MADE_TO_ORDER_TERMS.standardLeadTimeDays - requested);

    const lines: AdjustedLine[] = input.lines.map((line) => ({
      ...line,
      // Every line that has a Lead Time, and no line that has not. The question is asked of
      // the answer Core already carried on the line rather than of the Strategy's *name*: a
      // Strategy is named by the key a Project wired it under (ADR-0052), so this Plugin does
      // not know what it is called and must not pretend to.
      adjustments:
        daysSaved > 0 && line.fulfilment.hasLeadTime
          ? [surchargeFor(line, requested, daysSaved)]
          : [],
    }));

    // One row per Adjustment just declared, reading the amount off the Adjustment rather than
    // working it out a second time — so the row and the Order can never disagree about what was
    // charged. It records what was *asked for*, which is the half Core will never hold, and it
    // names the Cart because there is no Order yet: `apply-adjustments` runs a long way in
    // front of Capture, which is exactly why this Step declares a compensation.
    const rows = lines.flatMap((line) =>
      line.adjustments.map((adjustment) => ({
        cartId: input.cart.id,
        variantId: line.variantId,
        requestedLeadTimeDays: requested,
        standardLeadTimeDays: MADE_TO_ORDER_TERMS.standardLeadTimeDays,
        amount: adjustment.amount,
        currency: line.currency,
      })),
    );

    if (rows.length > 0) {
      const inserted = await context.db
        .insert(madeToOrderSurcharge)
        .values(rows)
        .returning({ id: madeToOrderSurcharge.id });

      const stack = written.get(input) ?? [];
      stack.push(inserted.map((row) => row.id));
      written.set(input, stack);
    }

    return { cart: input.cart, lines, adjustments: [] };
  },

  async (input, context) => {
    const ids = written.get(input)?.pop();
    // Nothing recorded, nothing to unwind. Core would not be here unless this Step completed,
    // but a compensation should not assume it is being called for the reason it expects.
    if (ids === undefined || ids.length === 0) return;

    await context.db
      .delete(madeToOrderSurcharge)
      .where(inArray(madeToOrderSurcharge.id, ids));
  },
);

/**
 * The Cart priced, adjusted by nothing — what this slot produces when there is no hurry to
 * charge for.
 *
 * Adjustments on the Order as a whole are always empty here, and that is the decision rather
 * than a gap: a Lead Time belongs to the line that has one, so a Return for that line refunds
 * the hurry along with the goods (ADR-0022).
 */
function unadjusted(input: PricedLines): AdjustedLines {
  return {
    cart: input.cart,
    lines: input.lines.map((line) => ({ ...line, adjustments: [] })),
    adjustments: [],
  };
}

/** The Adjustment for one line: signed minor units, positive because a surcharge adds. */
function surchargeFor(
  line: PricedLine,
  requested: number,
  daysSaved: number,
): Adjustment {
  return {
    code: LEAD_TIME_SURCHARGE_CODE,
    description: `Made to order in ${requested} ${dayWord(requested)} rather than ${MADE_TO_ORDER_TERMS.standardLeadTimeDays}.`,
    amount: daysSaved * MADE_TO_ORDER_TERMS.surchargePerDaySaved * line.quantity,
    // The Plugin's own account of how it got there, for whoever reads the Order later. Core
    // stores it and parses none of it (ADR-0004).
    metadata: {
      requestedLeadTimeDays: requested,
      standardLeadTimeDays: MADE_TO_ORDER_TERMS.standardLeadTimeDays,
      daysSaved,
      surchargePerDaySaved: MADE_TO_ORDER_TERMS.surchargePerDaySaved,
    },
  };
}

/**
 * The Lead Time the caller asked for, or `undefined` when they asked for none.
 *
 * Absent is an ordinary answer — a Shopper who says nothing is content with the standard
 * interval and pays nothing extra — and it is the answer every Cart of ordinary goods gives,
 * since nothing else in kobai sends this key.
 *
 * Anything else is a **refusal**, with this Plugin's own reason: a value that cannot be read is
 * a storefront asking for something, and delivering late while charging nothing would be a
 * worse answer than declining. A Step's refusal travels to the caller as itself, which is what
 * makes a Plugin able to decline a purchase at all.
 *
 * It is read **before** the lines are looked at, so a Cart holding nothing made to order is
 * refused too. That is deliberate: the value is unreadable whatever is in the Cart, and a
 * storefront that spells this key wrong should find out at its first Order rather than at its
 * first commission. The cost is that one broken parameter refuses every placement, which is the
 * loud half of a choice between loud and late.
 *
 * The value arrives as a string, because the open context is filled from a query string (#121).
 * A number is accepted too, so that a transport which one day carries typed values needs no
 * change here.
 */
function requestedLeadTimeDays(
  metadata: Readonly<Record<string, unknown>>,
): number | undefined {
  const asked = metadata[LEAD_TIME_DAYS_KEY];
  if (asked === undefined || asked === "") return undefined;

  if (typeof asked === "number") {
    if (!Number.isSafeInteger(asked) || asked < 0) throw notADuration(asked);
    return asked;
  }
  // Digits and nothing else, rather than whatever `Number` is willing to coerce: `Number("")`
  // and `Number(" ")` are both `0`, which would read a caller's mistake as the most urgent
  // request they could have made.
  if (typeof asked !== "string" || !/^\d+$/.test(asked)) throw notADuration(asked);

  const requested = Number(asked);
  if (!Number.isSafeInteger(requested)) throw notADuration(asked);

  return requested;
}

function notADuration(asked: unknown): StepFailure {
  return new StepFailure(
    "lead-time-not-understood",
    `${JSON.stringify(LEAD_TIME_DAYS_KEY)} was ${JSON.stringify(asked)}, and a Lead Time is a whole number of days from now. This Store makes some of what it sells to order, so it declines rather than guessing at when the Shopper wanted it.`,
  );
}

/** English, for a description a person reads. */
function dayWord(count: number): string {
  return count === 1 ? "day" : "days";
}
