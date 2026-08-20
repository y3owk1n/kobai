import type { Queryable } from "../db/client.ts";
import type { ChannelIdentity } from "../store/channel.ts";
import { readDefaultRegion } from "../store/read.ts";
import { readRegion } from "../store/region.ts";
import type { PriceMarket } from "./resolve-price.ts";

/**
 * Which market a price request is asked in — the route's half of `resolve-price`'s input
 * (#292, ADR-0074).
 *
 * The Workflow is handed a Region and a Channel; this is where the `?region=` a storefront sent
 * becomes one. It is **not** a Step, deliberately, and the reason is the status: a Region this
 * Store has not got is refused at **400** before the Workflow runs, where a Step's refusal is a
 * 404 or a 422 and reports a run. An unknown Region is a bad *parameter* — the same judgement
 * `?collection=` gets on the two Product lists — and silently answering for the default instead
 * would hide a storefront's bug behind a plausible number (story 15).
 *
 * Both price routes reach it, so the fallback is stated once: `GET /store/variants/{id}/price`
 * and `GET /admin/variants/{id}/price` cannot disagree about what a request naming no Region
 * means.
 */

/** A market, or why the `?region=` that was sent cannot name one. */
export type MarketAsked =
  | { readonly ok: true; readonly market: PriceMarket }
  | { readonly ok: false; readonly detail: string };

/**
 * Resolves the market a price is asked in: the Region named, or the Store's default, and the
 * Channel the credential is in.
 *
 * **Absent means the Store's default Region, and that is what keeps this additive** (ADR-0060):
 * every storefront written before this parameter existed sends nothing and is answered exactly
 * as it was, because the Region seeded at boot selects the currency every Price was already
 * denominated in (`store/seed.ts`).
 *
 * **A blank `?region=` is a Region that was named and is not one.** It is refused rather than
 * read as absent: a storefront interpolating an empty variable into its URL has a bug, and the
 * whole reason this refuses at all is to make that visible.
 */
export async function marketAsked(
  db: Queryable,
  asked: string | undefined,
  channel: ChannelIdentity | null,
): Promise<MarketAsked> {
  if (asked === undefined) {
    const fallback = await readDefaultRegion(db);
    if (!fallback) {
      return {
        ok: false,
        detail:
          "This deployment has no default Region, so a price cannot be resolved for a request that names none. Name one with `region=` — `GET /admin/regions` lists them — or point the Store at a default with `PATCH /admin/store`.",
      };
    }
    return { ok: true, market: { region: fallback, channel } };
  }

  const named = await readRegion(db, asked);
  if (!named) {
    return {
      ok: false,
      detail: `\`region\` must be the \`id\` of a Region this Store has, and ${JSON.stringify(asked)} is not one. \`GET /admin/regions\` lists them. Leave it out to be answered for this Store's default Region.`,
    };
  }

  return {
    ok: true,
    // The `metadata` a Region carries is the Merchant's and the Project's, and it is dropped
    // here rather than in the Workflow: what prices a request is where it is and what it prices
    // in, and a bag travelling to a storefront on every price is a field nobody asked for.
    market: {
      region: { id: named.id, name: named.name, currency: named.currency },
      channel,
    },
  };
}

/**
 * The two columns of a Cart that decide the market it is priced in (#293).
 *
 * The row rather than the whole Cart, because this is asked on the placement path where what is
 * in hand is a query's result — and because naming the two columns is what makes the rule below
 * legible at the call site.
 */
export type CartMarket = {
  /** `null` for a Cart started before kobai recorded where a Cart is bought. */
  readonly regionId: string | null;
  readonly currency: string;
};

/**
 * The market a **Cart** is priced in: its own Region, or the Store's default where it names
 * none — and always its own stamped currency (#293, ADR-0074).
 *
 * **The currency is the Cart's and never the Region's, and that is the whole point of this
 * function.** `core_cart.currency` is a copy taken when the Region was set, so a Merchant who
 * moves a Region onto another currency (`PATCH /admin/regions/{id}`) does not reprice a Cart
 * that already exists — which would otherwise happen silently, in the middle of a checkout,
 * possibly while the Shopper is at their bank paying the old figure. The Region says *where*
 * and the Cart says *what in*, and this is the one place the two are put back together.
 *
 * **A Cart naming no Region falls back to the Store's default**, exactly as
 * {@link marketAsked} does for a request that names none: it is the honest answer for a Cart
 * started before the column existed, and it is what such a Cart was already being priced for.
 *
 * `undefined` is a deployment that cannot price this Cart at all — no Region of its own and no
 * default to fall back to, which is a database migrated but never booted against
 * (`store/seed.ts`). The caller says what that means on its own path.
 */
export async function marketOfCart(
  db: Queryable,
  asked: CartMarket,
  channel: ChannelIdentity | null,
): Promise<PriceMarket | undefined> {
  const region =
    asked.regionId === null
      ? await readDefaultRegion(db)
      : await readRegion(db, asked.regionId);
  if (!region) return undefined;

  return {
    // `name` and `id` are the Region's own and the currency is the Cart's — see above.
    region: { id: region.id, name: region.name, currency: asked.currency },
    channel,
  };
}
