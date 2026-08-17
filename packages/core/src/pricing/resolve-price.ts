import { asc, eq } from "drizzle-orm";
import { price, variant } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
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
 *   rule; it hands over every candidate, in a stable order, with their `metadata`.
 * - **`select-price`** chooses among them. *That* is the rule, and it is a placeholder —
 *   see below.
 *
 * The split matters more than it looks. Choosing in TypeScript over a loaded list, rather
 * than in `order by … limit 1`, is what makes the rule replaceable without also replacing
 * the query — so a Project that wants the cheapest Price, or one that reads a lead time out
 * of `metadata` (ADR-0013), swaps one Step and inherits the loading.
 */

/** What a storefront asks: this Variant, what does it cost. */
export type PriceResolutionRequest = {
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
export type LoadedPrices = {
  readonly variant: VariantIdentity;
  /** Every Price on the Variant, oldest first — a total order, so it never varies. */
  readonly prices: readonly PriceCandidate[];
};

/** The Workflow's output: one Price, and the Variant it prices. */
export type ResolvedPrice = {
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
        metadata: price.metadata,
        createdAt: price.createdAt,
      })
      .from(price)
      .where(eq(price.variantId, found.id))
      .orderBy(asc(price.createdAt), asc(price.id));

    return { variant: found, prices };
  },
);

/**
 * Chooses which Price applies. **Newest wins.**
 *
 * This is a placeholder, and it is a named Step so that it is visible as one. Nothing yet
 * distinguishes two Prices on the same Variant — Region, Channel, quantity and customer
 * group are the constraint columns that would, and none of them exists (ADR-0008). Until
 * they do, "the one set most recently" is the only rule that is both deterministic and
 * honest about being arbitrary, and `id` breaks the tie so two Prices written in the same
 * instant still resolve the same way twice running.
 *
 * A Project that disagrees replaces this one Step and keeps everything else — which is the
 * whole point of the Workflow being declared rather than written as a method.
 */
export const selectPrice = defineStep(
  "select-price",
  (input: LoadedPrices): ResolvedPrice => {
    const chosen = input.prices.reduce<PriceCandidate | undefined>(
      (best, candidate) => (best && !isNewer(candidate, best) ? best : candidate),
      undefined,
    );

    if (!chosen) {
      throw refuse(
        "price-not-set",
        "This Variant carries no Price. A Variant is sellable once a Price has been set on it.",
      );
    }

    return {
      variant: input.variant,
      // Deliberately not the whole candidate: `metadata` belongs to the Merchant and the
      // Project, and this output is served to a storefront.
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
