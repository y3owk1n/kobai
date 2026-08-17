import { defineStep, type InsertedStep, type ResolvedPrice } from "@kobai/core";
import { eq } from "drizzle-orm";
import { priceLogEntry } from "./db/schema.ts";

/**
 * The Step this Plugin **offers** — and offering is the whole of what it does (ADR-0017).
 *
 * Importing this module installs nothing. A Project that wants prices recorded says so in its
 * `kobai.config.ts`, beside every other thing it has customised:
 *
 * ```ts
 * workflows: {
 *   "resolve-price": { after: { "select-price": [recordPriceResolution] } },
 * }
 * ```
 *
 * `after` rather than `steps`, because this Step watches rather than owns. Its input and its
 * output are the same type, so it cannot change what a storefront is told however it is
 * wired — which is exactly what makes it safe to put in somebody else's Workflow.
 */

/**
 * What this Step wrote, for the run that wrote it.
 *
 * Core hands a compensation the **very value** its `run` was given, so the resolved Price is
 * the key that ties the two halves together — no bookkeeping crosses between runs, and a
 * failure now can only ever undo what this run did. Weak, so a run that succeeds leaves
 * nothing behind to collect; and outside the Step rather than on the value, because the value
 * belongs to the Workflow and a Step that watches may not write on what it passes along.
 */
const written = new WeakMap<ResolvedPrice, string>();

export const recordPriceResolution: InsertedStep<ResolvedPrice> = defineStep(
  "record-price-resolution",

  async (resolved: ResolvedPrice, context): Promise<ResolvedPrice> => {
    const [row] = await context.db
      .insert(priceLogEntry)
      .values({
        // Core's Variant by ID, and the amount and currency as served. A copy rather than a
        // reference: what a storefront was told is a fact about a moment, and it should not
        // change later because a Merchant edited a Price.
        variantId: resolved.variant.id,
        amount: resolved.price.amount,
        currency: resolved.price.currency,
      })
      .returning({ id: priceLogEntry.id });

    if (row) written.set(resolved, row.id);

    // Handed straight back, untouched. This Step is here to watch.
    return resolved;
  },

  async (resolved, context) => {
    const id = written.get(resolved);
    // Nothing recorded, nothing to unwind — the Workflow may have failed before this Step
    // ever ran, in which case Core would not be here at all, but a compensation should not
    // assume it is being called for the reason it expects.
    if (id === undefined) return;

    written.delete(resolved);
    await context.db.delete(priceLogEntry).where(eq(priceLogEntry.id, id));
  },
);
