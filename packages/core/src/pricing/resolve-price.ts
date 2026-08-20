import { asc, eq } from "drizzle-orm";
import { price, variant } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import type { ChannelIdentity } from "../store/channel.ts";
import type { RegionIdentity } from "../store/region.ts";
import { defineStep, StepFailure } from "../workflow/step.ts";
import { defineWorkflow } from "../workflow/workflow.ts";

/**
 * **`resolve-price`** — what a Variant costs, as a declared Workflow rather than a service
 * method.
 *
 * This is the Workflow ADR-0003 calls kobai's flagship customisation mechanism, and it is
 * written to be *read*: `priceResolutionWorkflow.describe()` names every Step in order, so a
 * Developer can see what the system does before changing any of it. Each Step declares what
 * it takes and what it gives back, which is what lets a replacement be checked by the
 * compiler rather than by a Merchant noticing wrong prices (ADR-0017).
 *
 * Two Steps, and the split is where the seam wants to be:
 *
 * - **`load-prices`** asks the database what Prices exist for this Variant. It applies no
 *   rule; it hands over every candidate, in a stable order, with their `metadata` and their
 *   constraint columns.
 * - **`select-price`** chooses among them. *That* is the rule — since #292 it is **best
 *   match** on the Region and the Channel rather than the placeholder it shipped as.
 *
 * The split matters more than it looks. Choosing in TypeScript over a loaded list, rather
 * than in `order by … limit 1`, is what makes the rule replaceable without also replacing
 * the query — so a Project that wants the cheapest Price, or one that reads a lead time out
 * of `metadata` (ADR-0013), swaps one Step and inherits the loading. It is also why the
 * candidates arrive **unfiltered**: narrowing them to the ones that could apply would be the
 * rule moving into the query, where a replacement cannot reach it.
 */

/**
 * The market a price is asked for: **where** a Shopper is buying, and **through what**.
 *
 * The pair travels together everywhere in this Workflow because it is one question — *what
 * does this cost, here* — and because a Step deciding on one of them has to be handed the
 * other or it cannot implement best match at all.
 *
 * **The Region comes from the request and the Channel from the credential** (ADR-0020,
 * ADR-0074). `GET /store/variants/{id}/price?region=` names the first and falls back to the
 * Store's default; the second is `core_api_key.channel_id`, decided when the key was minted, so
 * a storefront neither threads a Channel through its requests nor can claim to be in one it was
 * not issued a credential for. `null` is the unconstrained Channel — *no particular route to
 * market* — which is every key that names none and every preview a Merchant asks from the
 * Admin, where there is no key at all.
 *
 * There is no `PriceMarket` with a `null` Region: a request is always priced *somewhere*, which
 * is what the Store owing a default Region buys (`store/seed.ts`).
 */
export type PriceMarket = {
  readonly region: RegionIdentity;
  readonly channel: ChannelIdentity | null;
};

/** What a storefront asks: this Variant, in this Region, through this Channel, what does it cost. */
export type PriceResolutionRequest = PriceMarket & {
  readonly variantId: string;
};

/**
 * Every way Core's own Steps can refuse.
 *
 * A closed union rather than the bare strings `StepFailure` carries, because the store
 * surface has to turn each of these into a status and should not be able to forget one — see
 * the `satisfies` in `http/store.ts`. A Step belonging to a Project or a Plugin refuses with
 * whatever reason it likes and is not in this union, which is the whole reason the union
 * exists: Core knows what *its* refusals mean and nothing about anybody else's.
 */
export type PriceResolutionRefusal = "variant-not-found" | "price-not-set";

/**
 * One Price a Variant carries, as a Step sees it.
 *
 * `metadata` is here on purpose. It is ADR-0004's untyped column, and it is the field a
 * replacement Step reads when it needs something Core does not model — which, with the
 * Workflow's open context, is the pair of doors ADR-0013 requires to exist.
 */
export type PriceCandidate = {
  readonly id: string;
  /** Minor units of `currency` — 1250 is `USD` 12.50. */
  readonly amount: number;
  readonly currency: string;
  /**
   * The Region this Price applies to, or `null` for **every** Region (ADR-0008).
   *
   * The identifier rather than the Region, because a candidate is compared and never reported:
   * what a chosen Price is *for* is {@link ResolvedPrice.region}, which is the market the
   * request named rather than the constraint the row carries — and for an unconstrained Price
   * those two are deliberately different things.
   */
  readonly regionId: string | null;
  /** The Channel this Price applies to, or `null` for **every** Channel. */
  readonly channelId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
};

/**
 * The Variant a resolution is about — its identifier and its SKU, and nothing else.
 *
 * The SKU travels with the id because it is what a Developer reads in a log line or a
 * response and recognises; the id alone identifies the row and nothing a person knows.
 */
export type VariantIdentity = {
  readonly id: string;
  readonly sku: string;
};

/** What `load-prices` produces and `select-price` chooses from. */
export type LoadedPrices = PriceMarket & {
  readonly variant: VariantIdentity;
  /** Every Price on the Variant, oldest first — a total order, so it never varies. */
  readonly prices: readonly PriceCandidate[];
};

/**
 * The Workflow's output: one Price, the Variant it prices, and the market it was priced for.
 *
 * **The market is carried out as well as in**, which is what makes the answer say which
 * question it answered: a storefront that sent no `?region=` was answered for the Store's
 * default and has no other way to learn which that was, and a Merchant previewing a price
 * needs to know it is looking at Malaysia's. It is also the half of #292's break to Extension
 * Point 2 that a compiler can see — see the record in ADR-0058.
 */
export type ResolvedPrice = PriceMarket & {
  readonly variant: VariantIdentity;
  readonly price: {
    readonly id: string;
    readonly amount: number;
    readonly currency: string;
  };
};

/**
 * Loads the Variant and every Price on it.
 *
 * Ordered `created_at` then `id`: `created_at` alone ties for Prices written in the same
 * instant, and a list whose order varies between two identical requests would make the Step
 * below non-deterministic for reasons nothing in the Workflow could explain.
 *
 * **Every Price, including the ones that cannot apply here.** Filtering by the Region, the
 * Channel or the currency in the `where` clause would put the rule in the query — and the
 * rule is what `select-price` is *for*, so a Project that replaced it would find half of its
 * candidates already gone (ADR-0017).
 */
export const loadPrices = defineStep(
  "load-prices",
  async (input: PriceResolutionRequest, context): Promise<LoadedPrices> => {
    // Checked before Postgres sees it: a malformed uuid raises, and an unhandled raise is a
    // 500 that reports a broken server for a request about something that does not exist.
    if (!isUuid(input.variantId)) throw noSuchVariant(input.variantId);

    const [found] = await context.db
      .select({ id: variant.id, sku: variant.sku })
      .from(variant)
      .where(eq(variant.id, input.variantId))
      .limit(1);
    if (!found) throw noSuchVariant(input.variantId);

    const prices = await context.db
      .select({
        id: price.id,
        amount: price.amount,
        currency: price.currency,
        regionId: price.regionId,
        channelId: price.channelId,
        metadata: price.metadata,
        createdAt: price.createdAt,
      })
      .from(price)
      .where(eq(price.variantId, found.id))
      .orderBy(asc(price.createdAt), asc(price.id));

    return { variant: found, region: input.region, channel: input.channel, prices };
  },
);

/**
 * How well a Price fits the market it is being asked about — higher is better, and `undefined`
 * is *does not apply here at all*.
 *
 * **Arithmetic with a right answer** (ADR-0008): a Price matching both the Region and the
 * Channel beats one matching the Region alone, which beats one matching the Channel alone,
 * which beats the unconstrained fallback. Two bits rather than four cases, so the ordering is
 * the one the tiers are numbered in and cannot drift from it.
 *
 * A Price naming a *different* Region or a *different* Channel does not apply, which is the
 * distinction that makes `null` mean **applies to all** rather than *matches nothing*.
 */
function tierOf(candidate: PriceCandidate, market: PriceMarket): number | undefined {
  if (candidate.regionId !== null && candidate.regionId !== market.region.id)
    return undefined;
  if (
    candidate.channelId !== null &&
    candidate.channelId !== (market.channel?.id ?? null)
  ) {
    return undefined;
  }
  return (candidate.regionId === null ? 0 : 2) + (candidate.channelId === null ? 0 : 1);
}

/**
 * Chooses which Price applies. **Best match, and the currency rule comes first.**
 *
 * Two rules, in this order, and the order is the decision:
 *
 * 1. **A Price not denominated in the Region's currency does not apply.** kobai converts
 *    nothing, ever (ADR-0074), so a Region selecting MYR is answered from the MYR Prices or
 *    from nothing at all — an unconstrained USD fallback is *not* a price in Malaysia, and best
 *    match must never be able to beat this rule. A Variant with no Price in the Region's
 *    currency answers the ordinary `price-not-set`.
 * 2. **Then the best match**, by {@link tierOf}: both constraints, then the Region, then the
 *    Channel, then the unconstrained fallback.
 *
 * **Ties within a tier are broken by an ordering ending in `id`.** Newest wins, which is what
 * makes `POST /admin/variants/{id}/prices` supersede rather than accumulate; `id` settles two
 * Prices written in the same instant, for #132's reason — a tie that reorders is a tie that will
 * one day skip.
 *
 * A Project that disagrees replaces this one Step and keeps everything else — which is the
 * whole point of the Workflow being declared rather than written as a method.
 */
export const selectPrice = defineStep(
  "select-price",
  (input: LoadedPrices): ResolvedPrice => {
    // The first rule, as a filter: what is left is every Price that applies here at all, each
    // with how well it fits. `flatMap` rather than `filter` then `map`, so a candidate is
    // judged once and the tier it was judged by is what survives.
    const applies = input.prices.flatMap((candidate) => {
      if (candidate.currency !== input.region.currency) return [];
      const tier = tierOf(candidate, input);
      return tier === undefined ? [] : [{ candidate, tier }];
    });

    // The second rule, as a comparison: a better tier wins, and inside one tier the newer Price
    // does — which is the whole of "best match, ties broken by an ordering ending in `id`".
    const best = applies.reduce<(typeof applies)[number] | undefined>(
      (winning, one) =>
        winning === undefined ||
        one.tier > winning.tier ||
        (one.tier === winning.tier && isNewer(one.candidate, winning.candidate))
          ? one
          : winning,
      undefined,
    );

    const chosen = best?.candidate;
    if (!chosen) {
      throw refuse(
        "price-not-set",
        `This Variant carries no Price that applies in ${JSON.stringify(input.region.name)}, which prices in ${input.region.currency}. A Variant is sellable in a Region once a Price denominated in that Region's currency has been set on it, and kobai converts nothing.`,
      );
    }

    return {
      variant: input.variant,
      region: input.region,
      channel: input.channel,
      // Deliberately not the whole candidate: `metadata` belongs to the Merchant and the
      // Project, and this output is served to a storefront. Nor its constraint columns — what
      // the answer is *for* is the market above, which is the question that was asked.
      price: { id: chosen.id, amount: chosen.amount, currency: chosen.currency },
    };
  },
);

/**
 * Price resolution, declared.
 *
 * Exported as a value rather than described in documentation, so "what does kobai do to
 * resolve a price" is answered by the same object that answers "what does kobai run".
 */
export const priceResolutionWorkflow = defineWorkflow<PriceResolutionRequest>(
  "resolve-price",
)
  .step(loadPrices)
  .step(selectPrice)
  .build();

/**
 * The declaration above, as a type.
 *
 * What a Project overrides is measured against this, and what the store surface runs is a
 * value of it — Core's own, or the one a Project's config rebuilt. The surface holds the type
 * rather than the value for exactly that reason: a route that imported the declaration
 * directly would serve Core's Steps no matter what the Project had wired.
 */
export type PriceResolutionWorkflow = typeof priceResolutionWorkflow;

function isNewer(candidate: PriceCandidate, best: PriceCandidate): boolean {
  const by = candidate.createdAt.getTime() - best.createdAt.getTime();
  return by === 0 ? candidate.id > best.id : by > 0;
}

function noSuchVariant(variantId: string): StepFailure {
  return refuse(
    "variant-not-found",
    `No Variant ${JSON.stringify(variantId)} exists. A Price belongs to the Variant, which is the sellable thing, and never to the Product.`,
  );
}

/**
 * A refusal from one of Core's own Steps.
 *
 * The narrowed `reason` is the point: it is what ties every refusal this Workflow can make to
 * {@link PriceResolutionRefusal}, so adding one here without saying what status it means is a
 * build failure rather than a 422 nobody chose.
 */
function refuse(reason: PriceResolutionRefusal, detail: string): StepFailure {
  return new StepFailure(reason, detail);
}
