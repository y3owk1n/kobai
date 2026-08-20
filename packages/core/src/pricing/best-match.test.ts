import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestApiKey,
  createTestKobai,
  seedTestCatalog,
  type TestApiKey,
  type TestKobai,
  type TestSession,
} from "../testing/index.ts";

/**
 * **Best match, once for every combination there is** (#292, ADR-0008).
 *
 * A Price carries a nullable Region and a nullable Channel, `null` meaning *applies to all*, and
 * resolution picks the best match: both constraints beat the Region alone, which beats the
 * Channel alone, which beats the unconstrained fallback. That is arithmetic with a right answer,
 * and the ticket asks for it as a table for exactly that reason — a prose case per rule would
 * assert four of the sixty-four things this file says.
 *
 * Four things about how it is written are worth carrying to the next table:
 *
 * - **The expected winner is written down, never computed.** A case that worked out which Price
 *   should win the way `select-price` works it out would pass by construction, which is the
 *   tautology this repository's testing guidance names. Every cell below is a literal somebody
 *   had to be able to defend.
 * - **The whole grid, including the empty and the impossible.** A Variant carrying only a
 *   Channel-constrained Price has **no** price for a request in another Channel — `null` here —
 *   and those cells are the half that says `null` means *applies to all* rather than *matches
 *   anything*.
 * - **One deployment, one Variant per combination.** Sixteen boots would be sixteen databases
 *   to arrange the same Store, and a Variant is independent of every other one: what a Price
 *   applies to is a fact about its own row. Each Variant carries only the Prices its case names,
 *   which is the arrangement being visible rather than inherited.
 * - **The Channel comes from the key**, so a market is asked with a *credential* rather than a
 *   parameter — three keys, one per Channel and one in none (ADR-0020). That is the whole of
 *   what a storefront does to be in a Channel.
 */

/** Which constraint a Price carries. The amount is how the answer says which one won. */
const PRICES = {
  /** Applies to every Region and every Channel — the fallback, and every Price written before #292. */
  unconstrained: 1000,
  /** The first Region, every Channel. */
  region: 2000,
  /** Every Region, the first Channel. */
  channel: 3000,
  /** The first Region **and** the first Channel — the narrowest fit there is. */
  both: 4000,
} as const;

type PriceKind = keyof typeof PRICES;

/** Which market a request is in: the Region it names, and the Channel its key is bound to. */
type Market =
  | "first-region-first-channel"
  | "first-region-second-channel"
  | "first-region-no-channel"
  | "second-region-first-channel";

/** One row of the grid: which Prices the Variant carries, and who wins in each market. */
type Case = {
  readonly carries: readonly PriceKind[];
} & Readonly<Record<Market, PriceKind | null>>;

/**
 * Every combination of the four kinds of Price, against four markets.
 *
 * Read a row as: *this Variant carries these Prices; a request from this market is answered
 * with that one, or with `price-not-set` where the cell is `null`.* Sixteen rows, because four
 * kinds of Price make sixteen subsets and the empty one is a case too.
 */
const GRID: readonly Case[] = [
  {
    carries: [],
    "first-region-first-channel": null,
    "first-region-second-channel": null,
    "first-region-no-channel": null,
    "second-region-first-channel": null,
  },
  {
    carries: ["unconstrained"],
    // The fallback applies everywhere, which is what makes a single-market Store pay nothing
    // for any of this: every Price written before Regions existed is this row.
    "first-region-first-channel": "unconstrained",
    "first-region-second-channel": "unconstrained",
    "first-region-no-channel": "unconstrained",
    "second-region-first-channel": "unconstrained",
  },
  {
    carries: ["region"],
    "first-region-first-channel": "region",
    "first-region-second-channel": "region",
    "first-region-no-channel": "region",
    // Constrained to the *other* Region, and there is nothing else: no price here.
    "second-region-first-channel": null,
  },
  {
    carries: ["channel"],
    "first-region-first-channel": "channel",
    "first-region-second-channel": null,
    // A key in no Channel is not in the first one, so a Channel-constrained Price is no more
    // applicable to it than one for a Channel it is not in.
    "first-region-no-channel": null,
    "second-region-first-channel": "channel",
  },
  {
    carries: ["both"],
    "first-region-first-channel": "both",
    "first-region-second-channel": null,
    "first-region-no-channel": null,
    "second-region-first-channel": null,
  },
  {
    carries: ["unconstrained", "region"],
    "first-region-first-channel": "region",
    "first-region-second-channel": "region",
    "first-region-no-channel": "region",
    "second-region-first-channel": "unconstrained",
  },
  {
    carries: ["unconstrained", "channel"],
    "first-region-first-channel": "channel",
    "first-region-second-channel": "unconstrained",
    "first-region-no-channel": "unconstrained",
    "second-region-first-channel": "channel",
  },
  {
    carries: ["unconstrained", "both"],
    "first-region-first-channel": "both",
    "first-region-second-channel": "unconstrained",
    "first-region-no-channel": "unconstrained",
    "second-region-first-channel": "unconstrained",
  },
  {
    carries: ["region", "channel"],
    // The Region beats the Channel, which is the one ordering in this table that could
    // reasonably have gone the other way and did not: a market's geography decides its currency
    // and its tax, and a route to market is a variation on top of that.
    "first-region-first-channel": "region",
    "first-region-second-channel": "region",
    "first-region-no-channel": "region",
    "second-region-first-channel": "channel",
  },
  {
    carries: ["region", "both"],
    "first-region-first-channel": "both",
    "first-region-second-channel": "region",
    "first-region-no-channel": "region",
    "second-region-first-channel": null,
  },
  {
    carries: ["channel", "both"],
    "first-region-first-channel": "both",
    "first-region-second-channel": null,
    "first-region-no-channel": null,
    "second-region-first-channel": "channel",
  },
  {
    carries: ["unconstrained", "region", "channel"],
    "first-region-first-channel": "region",
    "first-region-second-channel": "region",
    "first-region-no-channel": "region",
    "second-region-first-channel": "channel",
  },
  {
    carries: ["unconstrained", "region", "both"],
    "first-region-first-channel": "both",
    "first-region-second-channel": "region",
    "first-region-no-channel": "region",
    "second-region-first-channel": "unconstrained",
  },
  {
    carries: ["unconstrained", "channel", "both"],
    "first-region-first-channel": "both",
    "first-region-second-channel": "unconstrained",
    "first-region-no-channel": "unconstrained",
    "second-region-first-channel": "channel",
  },
  {
    carries: ["region", "channel", "both"],
    "first-region-first-channel": "both",
    "first-region-second-channel": "region",
    "first-region-no-channel": "region",
    "second-region-first-channel": "channel",
  },
  {
    carries: ["unconstrained", "region", "channel", "both"],
    // The whole ladder in one Variant: both, then the Region, then the Channel, then the
    // fallback — each cell reached by taking one rung away.
    "first-region-first-channel": "both",
    "first-region-second-channel": "region",
    "first-region-no-channel": "region",
    "second-region-first-channel": "channel",
  },
];

const MARKETS = [
  "first-region-first-channel",
  "first-region-second-channel",
  "first-region-no-channel",
  "second-region-first-channel",
] as const satisfies readonly Market[];

/**
 * How long the one arrangement below is given.
 *
 * Longer than a case's default because it is not a case: it stands a Store up, makes sixteen
 * Variants, two Regions, two Channels, three keys and forty Prices through the public API, which
 * is forty round trips before the first assertion. A number is named here rather than left to
 * the default so that a slow machine reports the sixteen cases failing rather than one hook
 * timing out with no explanation.
 */
const ARRANGING_THE_STORE_MS = 60_000;

/** The one deployment every case below asks, arranged once. */
let kobai: TestKobai;
let merchant: TestSession;
let firstRegion: string;
let secondRegion: string;
let keys: Readonly<Record<Market, TestApiKey>>;
/** Which Variant carries which case's Prices, by the index of its row in the grid. */
let variants: string[];

beforeAll(async () => {
  kobai = await createTestKobai();

  // Sixteen Variants under one Product, one per row: a Variant's Prices are its own, so the
  // cases cannot reach each other, and a Product with sixteen Variants is an ordinary Product.
  const catalog = await seedTestCatalog(kobai, {
    variants: GRID.map((_, index) => ({ sku: `CASE-${index}`, prices: [] })),
  });
  merchant = catalog.merchant;
  variants = GRID.map((_, index) => catalog.variant(`CASE-${index}`).id);

  firstRegion = await createRegion("The first Region");
  secondRegion = await createRegion("The second Region");
  const firstChannel = await createChannel("The first Channel");
  const secondChannel = await createChannel("The second Channel");

  keys = {
    "first-region-first-channel": await keyIn(firstChannel),
    "first-region-second-channel": await keyIn(secondChannel),
    // No `channelId` at all — the unconstrained key, which is every key that existed before
    // Channels did and every key a deployment with one route to market mints.
    "first-region-no-channel": await keyIn(undefined),
    "second-region-first-channel": await keyIn(firstChannel),
  };

  for (const [index, one] of GRID.entries()) {
    for (const kind of one.carries) {
      await setPrice(variants[index] ?? "", kind, firstRegion, firstChannel);
    }
  }
}, ARRANGING_THE_STORE_MS);

afterAll(async () => {
  await kobai?.close();
});

describe("a Price is resolved by best match on the Region and the Channel", () => {
  for (const [index, one] of GRID.entries()) {
    const carrying =
      one.carries.length === 0 ? "no Price at all" : one.carries.join(" + ");

    for (const market of MARKETS) {
      const expected = one[market];

      it(`answers ${expected ?? "price-not-set"} for a Variant carrying ${carrying}, in ${market}`, async () => {
        const region =
          market === "second-region-first-channel" ? secondRegion : firstRegion;

        const response = await kobai.request(
          `/store/variants/${variants[index]}/price?region=${region}`,
          { headers: keys[market].headers },
        );

        if (expected === null) {
          // The ordinary refusal for a Variant nobody has priced, said about a market rather
          // than about the Variant: there is a Price here, and none of them applies.
          expect(response.status).toBe(404);
          await expect(response.json()).resolves.toMatchObject({
            reason: "price-not-set",
          });
          return;
        }

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          price: { amount: PRICES[expected] },
        });
      });
    }
  }
});

describe("two Prices in one tier", () => {
  it("resolves to the newer, and to the same one twice running", async () => {
    // The tie the ordering ends in `id` for (#132). Two Prices constrained identically are two
    // rows in one tier, so what separates them is `created_at` and then `id` — and *newest
    // wins* is what makes `POST /admin/variants/{id}/prices` supersede rather than accumulate,
    // which is the only way this surface has to correct a Price.
    await using instance = await createTestKobai();
    const catalog = await seedTestCatalog(instance, { prices: [] });
    const headers = {
      ...catalog.merchant.headers,
      "content-type": "application/json",
    };

    for (const amount of [1250, 999]) {
      const created = await instance.request(
        `/admin/variants/${catalog.variantId}/prices`,
        { method: "POST", headers, body: JSON.stringify({ amount }) },
      );
      expect(created.status).toBe(201);
    }

    const answers = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await instance.request(
        `/store/variants/${catalog.variantId}/price`,
        { headers: catalog.apiKey.headers },
      );
      answers.push(
        ((await response.json()) as { price: { amount: number } }).price.amount,
      );
    }

    expect(answers).toEqual([999, 999]);
  });

  it("resolves the same one when both were written in the same instant", async () => {
    // **The half `created_at` cannot settle, and the reason the ordering ends in `id`** (#132).
    // Two Prices written in one instant tie on the timestamp, and a tie that reorders between
    // two identical requests is one that will one day pick a different amount — so `id` breaks
    // it, and the greater one wins because that is what "newest" degrades to.
    //
    // The instant is **arranged rather than raced**: two requests cannot be made to share a
    // `now()` on purpose, so the rows are wound onto one timestamp afterwards, the way a test
    // about an expired session winds `expires_at` back. Nothing else here can reach this case.
    await using instance = await createTestKobai();
    const catalog = await seedTestCatalog(instance, { prices: [] });
    const headers = {
      ...catalog.merchant.headers,
      "content-type": "application/json",
    };

    const written: { id: string; amount: number }[] = [];
    for (const amount of [1250, 999]) {
      const created = await instance.request(
        `/admin/variants/${catalog.variantId}/prices`,
        { method: "POST", headers, body: JSON.stringify({ amount }) },
      );
      expect(created.status).toBe(201);
      written.push((await created.json()) as { id: string; amount: number });
    }

    await instance.database.query(
      "update core_price set created_at = timestamptz '2026-01-01 00:00:00+00'",
    );

    const response = await instance.request(
      `/store/variants/${catalog.variantId}/price`,
      { headers: catalog.apiKey.headers },
    );

    // Whichever identifier sorts higher, which is a coin toss at write time and settled for
    // ever afterwards — the assertion is that the answer is *that* one rather than that it is a
    // particular amount, because the identifiers are random and the rule is about their order.
    const expected = written.reduce((best, one) => (one.id > best.id ? one : best));
    await expect(response.json()).resolves.toMatchObject({
      price: { id: expected.id, amount: expected.amount },
    });
  });
});

/** A Region selecting the currency this Store already prices in. */
async function createRegion(name: string): Promise<string> {
  const response = await kobai.request("/admin/regions", {
    method: "POST",
    headers: { ...merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ name, currency: "USD" }),
  });
  expect(response.status, `creating ${name}`).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function createChannel(name: string): Promise<string> {
  const response = await kobai.request("/admin/channels", {
    method: "POST",
    headers: { ...merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(response.status, `creating ${name}`).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** A key bound to a Channel, or to none — which is the whole of how a request is in one. */
async function keyIn(channelId: string | undefined): Promise<TestApiKey> {
  return createTestApiKey(kobai, merchant, {
    name: channelId === undefined ? "in no Channel" : `in ${channelId}`,
    channelId,
  });
}

/** One Price of a kind, on a Variant. */
async function setPrice(
  variantId: string,
  kind: PriceKind,
  regionId: string,
  channelId: string,
): Promise<void> {
  const response = await kobai.request(`/admin/variants/${variantId}/prices`, {
    method: "POST",
    headers: { ...merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({
      amount: PRICES[kind],
      regionId: kind === "region" || kind === "both" ? regionId : undefined,
      channelId: kind === "channel" || kind === "both" ? channelId : undefined,
    }),
  });
  expect(response.status, `pricing ${variantId} (${kind})`).toBe(201);
}
