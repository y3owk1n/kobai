import {
  defineStep,
  type LoadedPrices,
  type ResolvedPrice,
  StepFailure,
} from "@kobai/core";

/**
 * This Project's own pricing rule, and it is **wrong on purpose**.
 *
 * The reference Project exists to exercise the extension surface on every commit (ADR-0029),
 * and an override you have to squint at proves nothing. So this one is unmistakable: whatever
 * a Merchant entered — $12.50, $900, anything — a storefront is told one cent. Nobody will
 * mistake that for kobai's own behaviour, which is the entire point.
 *
 * It replaces `select-price`, the placeholder "newest wins" rule in Core's `resolve-price`
 * Workflow. Everything else is inherited: `load-prices` still asks the database what Prices a
 * Variant carries, and this Step still refuses when there are none, because a Variant with no
 * Price is not sellable and a demonstration should not quietly change that too.
 *
 * Nothing in `@kobai/core` knows this file exists. It is wired in `kobai.config.ts`, and
 * removing that one line puts the Merchant's Price back.
 */

/** Amounts are minor units, so this is one cent of whatever currency the Price is in. */
const ONE_CENT = 1;

export const everythingCostsOneCent = defineStep(
  "everything-costs-one-cent",
  (input: LoadedPrices): ResolvedPrice => {
    // Which Price is picked barely matters when the amount is thrown away, but the currency
    // and the identifier come from a real row rather than being invented — the answer should
    // still point at something a Merchant can find.
    const [chosen] = input.prices;

    if (!chosen) {
      throw new StepFailure(
        "price-not-set",
        "This Variant carries no Price. Even here, a Variant is sellable only once a Price has been set on it.",
      );
    }

    return {
      variant: input.variant,
      price: { id: chosen.id, amount: ONE_CENT, currency: chosen.currency },
    };
  },
);
