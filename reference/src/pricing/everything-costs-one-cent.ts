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
 * It replaces `select-price`, Core's best-match rule in the `resolve-price` Workflow.
 * Everything else is inherited: `load-prices` still asks the database what Prices a Variant
 * carries, and this Step still refuses when there are none, because a Variant with no Price is
 * not sellable and a demonstration should not quietly change that too.
 *
 * **It was rewritten by #292, and the compiler is what asked for it.** `resolve-price` grew a
 * Region and a Channel — a deliberate break to Extension Point 2, taken under ADR-0058's
 * pre-release licence and recorded in that ADR's register — and this file stopped compiling on
 * the day it landed, which is exactly the notice that rule promises a Developer. What the edit
 * had to decide is written at the line: the market comes back out untouched, and the Region's
 * currency is honoured although the amount is not, because kobai converts nothing.
 *
 * Nothing in `@kobai/core` knows this file exists. It is wired in `kobai.config.ts`, and
 * removing that one line puts the Merchant's Price back.
 */

/** Amounts are minor units, so this is one cent of whatever the Region prices in. */
const ONE_CENT = 1;

export const everythingCostsOneCent = defineStep(
  "everything-costs-one-cent",
  (input: LoadedPrices): ResolvedPrice => {
    // **The Region decides the currency, and this Step obeys that rule although it breaks every
    // other one** (#292). kobai converts nothing, so a Variant priced only in dollars has no
    // price in a ringgit Region — one cent of the wrong currency would be a conversion, which is
    // the one thing a demonstration must not quietly invent. Which of the candidates is picked
    // still barely matters when the amount is thrown away, but the identifier comes from a real
    // row rather than being made up: the answer should point at something a Merchant can find.
    const chosen = input.prices.find((one) => one.currency === input.region.currency);

    if (!chosen) {
      throw new StepFailure(
        "price-not-set",
        `This Variant carries no Price in ${input.region.currency}, which is what ${JSON.stringify(input.region.name)} prices in. Even here, a Variant is sellable in a Region only once a Price denominated in that Region's currency has been set on it.`,
      );
    }

    return {
      variant: input.variant,
      // Handed back rather than invented: the market is what the request asked about, and a Step
      // that answered for another Region would be answering a different question. It is also
      // where a Developer sees, in the response, that their own Step was given the Region.
      region: input.region,
      channel: input.channel,
      price: { id: chosen.id, amount: ONE_CENT, currency: chosen.currency },
    };
  },
);
