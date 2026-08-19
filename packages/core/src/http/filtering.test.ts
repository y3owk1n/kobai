import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  seedTestOrder,
  signInTestMerchant,
  type TestKobai,
  type TestSession,
} from "../testing/index.ts";
import { OPENAPI_DOCUMENT_PATH } from "./openapi.ts";

/**
 * Narrowing a list route — the filtering convention, once for every filter there is.
 *
 * **Its own file rather than another table in `pagination.test.ts`, and the reason is that
 * file's own argument turned round.** Paging is asserted once for every list because the page
 * envelope is *the same everywhere*: `limit`, `after` and a `nextCursor`, whatever the list is
 * of. Filters are not — `state` and `status` narrow different tables by different facts, and
 * `?collection=` will narrow by a row rather than by a word. What *is* the same everywhere is
 * the handful of promises below, and those are what this file holds. A list with no filter has
 * no entry here and needs none; a filter added to a list already in `LISTS` is one entry here
 * and inherits the lot.
 *
 * The three promises, which are the convention (#209):
 *
 * - **Absent means unfiltered.** A caller that sends nothing is answered the whole list, which
 *   is what made every one of these filters additive: a client written before the parameter
 *   existed is answered rather than refused.
 * - **An unknown value is refused at 400, from the schema, never ignored.** A filter quietly
 *   dropped answers a different question from the one that was asked, and hands back a page the
 *   caller reads as the truth. The refusal is `pageQuery`'s existing `invalid` — an unusable
 *   parameter does not fit the endpoint's schema and needs no `reason` of its own (ADR-0060).
 * - **A filter composes with ADR-0064's cursor**, and a filtered page being short is still not
 *   an end-of-list signal. This is the case that clause of ADR-0064 was written for and the
 *   first thing to exercise it: the filter is applied in the same statement as the page, so
 *   `nextCursor` still means what it means and a caller that stopped on a short page would stop
 *   early.
 *
 * **What a filter *means* stays asserted where the list is.** That a `spent` Cart is one that
 * became an Order, that an archived Product is one taken off the storefront: those are facts
 * about a table, and they belong beside it. This file asserts that the narrowing narrows to
 * whatever the entry says it should, and nothing about why.
 */

/**
 * As much of the description as this file reads: which query parameters each operation declares.
 *
 * **Every operation of every path, not only each `get`.** A filter lives on a list and every list
 * is a `get` today, so reading one verb would be right about the surface as it stands and wrong
 * about the sentence this sweep exists to enforce — a query parameter is a query parameter
 * whichever verb declares it, and one on a `post` is exactly the sort of thing that arrives
 * without anybody thinking of this file.
 */
type DescribedPaths = {
  readonly paths: Record<
    string,
    Record<
      string,
      {
        readonly parameters?: readonly { readonly name: string; readonly in: string }[];
      }
    >
  >;
};

/**
 * ADR-0064's own two, which every list takes and no entry here is about.
 *
 * The sweep at the foot of this file subtracts them from what the description declares, so what
 * is left is exactly the filters — and a third paging parameter added to `pageParameters` would
 * arrive here as an unaccounted-for filter, which is the right place to have to think about it.
 */
const PAGING = ["limit", "after"];

/**
 * A deployment arranged for one entry: every row the unfiltered list holds, and which of them
 * each value should answer.
 *
 * **`matching` is a map rather than a partition**, deliberately. Today's two filters do
 * partition their lists — a Cart is live, expired or spent, and a Product is a draft, published
 * or archived — but `?collection=` does not: a Product may be in several Collections and in
 * none, so the values overlap and their union is not the list. Assuming a partition here would
 * be a rule this convention does not have, written into the one place the next filter has to
 * pass through.
 */
type Arranged = {
  /** Every row of the list, newest first — what the unfiltered page must contain. */
  readonly all: readonly string[];
  /** Per value, the rows that value narrows to, newest first. */
  readonly matching: Readonly<Record<string, readonly string[]>>;
};

/**
 * One filter: which list, which parameter, what it accepts, and how to arrange a deployment
 * where the answer is known.
 *
 * A table rather than a copy of each assertion per filter, so the next one is one entry and is
 * held to the whole convention rather than to a copy of it — which is `pagination.test.ts`'s
 * bargain with `LISTS`, made again about the thing that table deliberately does not cover.
 *
 * `paged` is the value the cursor case walks, and it has to be one the arrangement gives at
 * least three rows: a page of one, then another, then a last one that reports no cursor is the
 * smallest arrangement in which "the filter survives the cursor" can fail.
 */
type Filter = {
  readonly path: string;
  /** What this list's rows are called in the envelope it answers with. */
  readonly key: string;
  /** The query parameter, spelled as the route spells it. */
  readonly parameter: string;
  /** Every value the route accepts, in no particular order. */
  readonly values: readonly string[];
  /**
   * A value the route does not accept.
   *
   * Named by the entry rather than derived from the description, because the next filter's
   * values are not a closed set at all: `?collection=` will take an identifier, and what makes a
   * value unusable there is a different question from what makes `sold-out` unusable here.
   */
  readonly unknown: string;
  /** The value the cursor case pages through. The arrangement must give it three rows. */
  readonly paged: string;
  readonly arrange: (kobai: TestKobai, merchant: TestSession) => Promise<Arranged>;
};

const FILTERS: readonly Filter[] = [
  {
    // The filter the convention was inferred from (#227, ADR-0071), and until now nothing
    // asserted any of it: `GET /admin/carts?state=` shipped with the three promises above true
    // and untested, which is exactly the drift this file exists to stop.
    path: "/admin/carts",
    key: "carts",
    parameter: "state",
    values: ["live", "expired", "spent"],
    unknown: "abandoned",
    paged: "live",
    arrange: arrangeCarts,
  },
  {
    // The filter this convention was written down for (#252): a Merchant's way to find their
    // drafts. `GET /store/products` takes no filter of its own and is deliberately not an entry
    // here — the store surface answers published Products in the *route*, because a client that
    // could ask for drafts is a client that will.
    path: "/admin/products",
    key: "products",
    parameter: "status",
    values: ["draft", "published", "archived"],
    unknown: "retired",
    paged: "published",
    arrange: arrangeProducts,
  },
];

/** One page of one list, with the item key normalised away so the assertions can be shared. */
async function fetchPage(
  kobai: TestKobai,
  filter: Filter,
  merchant: TestSession,
  query = "",
): Promise<{ readonly status: number; readonly items: readonly string[] }> {
  const response = await kobai.request(`${filter.path}${query}`, {
    headers: merchant.headers,
  });
  const body = (await response.json()) as Record<string, unknown>;
  return {
    status: response.status,
    items: ((body[filter.key] ?? []) as readonly { readonly id: string }[]).map(
      (one) => one.id,
    ),
  };
}

/** Both halves of a page: its rows and the cursor for what follows, or none. */
async function fetchPageWithCursor(
  kobai: TestKobai,
  filter: Filter,
  merchant: TestSession,
  query: string,
): Promise<{ readonly items: readonly string[]; readonly nextCursor?: string }> {
  const response = await kobai.request(`${filter.path}${query}`, {
    headers: merchant.headers,
  });
  expect(response.status, `${filter.path}${query}`).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  return {
    items: ((body[filter.key] ?? []) as readonly { readonly id: string }[]).map(
      (one) => one.id,
    ),
    nextCursor: body.nextCursor as string | undefined,
  };
}

describe("every filter narrows the same way", () => {
  it.each(FILTERS)("$path?$parameter is absent and the list is whole", async (filter) => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const arranged = await filter.arrange(kobai, merchant);

    const unfiltered = await fetchPage(kobai, filter, merchant, "?limit=100");

    expect(unfiltered.status).toBe(200);
    // Every row, and in the order the list promises — a filter that had somehow reached this
    // request would take rows out of it, which is what nothing narrowing has to mean.
    expect(unfiltered.items).toEqual(arranged.all);
  });

  it.each(FILTERS)("$path?$parameter answers exactly what it names", async (filter) => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const arranged = await filter.arrange(kobai, merchant);

    for (const value of filter.values) {
      const narrowed = await fetchPage(
        kobai,
        filter,
        merchant,
        `?limit=100&${filter.parameter}=${value}`,
      );

      const where = `${filter.path}?${filter.parameter}=${value}`;
      expect(narrowed.status, where).toBe(200);
      // Equality rather than a containment check in either direction: a filter that answered
      // too much and one that answered too little are two different bugs and both are here.
      expect(narrowed.items, where).toEqual(arranged.matching[value] ?? []);
    }
  });

  it.each(FILTERS)(
    "$path?$parameter refuses a value it does not have, rather than ignoring it",
    async (filter) => {
      await using kobai = await createTestKobai();
      const merchant = await signInTestMerchant(kobai);
      await filter.arrange(kobai, merchant);

      const response = await kobai.request(
        `${filter.path}?${filter.parameter}=${filter.unknown}`,
        { headers: merchant.headers },
      );

      // 400 and not a page. A filter silently dropped hands back the whole list under a
      // heading that says otherwise, and the caller has no way to tell that from the truth —
      // which is the failure that makes this a rule rather than a nicety.
      expect(response.status).toBe(400);
      // `pageQuery`'s existing `invalid`, not a `reason` of its own: an unusable query
      // parameter does not fit the endpoint's schema, which is what that word already means
      // everywhere on this surface, and a new one would be permanent under ADR-0060.
      await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
    },
  );

  it.each(FILTERS)(
    "$path?$parameter is still the filter on the second page",
    async (filter) => {
      await using kobai = await createTestKobai();
      const merchant = await signInTestMerchant(kobai);
      const arranged = await filter.arrange(kobai, merchant);
      const expected = arranged.matching[filter.paged] ?? [];
      // The arrangement rather than the subject, so it is asserted rather than assumed: with
      // fewer than three rows the walk below ends on its first page and proves nothing.
      expect(
        expected.length,
        `${filter.path}?${filter.parameter}=${filter.paged} needs three rows to page through`,
      ).toBeGreaterThanOrEqual(3);

      const narrowing = `${filter.parameter}=${filter.paged}`;
      const seen: string[] = [];
      let cursor: string | undefined;
      // A page size of one, so every boundary in the filtered list is a boundary between two
      // pages. A bound, so a cursor that never advanced fails here rather than hanging.
      for (let page = 0; page < 20; page += 1) {
        const answered = await fetchPageWithCursor(
          kobai,
          filter,
          merchant,
          `?limit=1&${narrowing}${cursor === undefined ? "" : `&after=${encodeURIComponent(cursor)}`}`,
        );
        seen.push(...answered.items);
        if (answered.nextCursor === undefined) break;
        cursor = answered.nextCursor;
      }

      // Every matching row exactly once and in order, and nothing else — so the filter was
      // still in force on the pages the cursor led to, which is the half a caller has to
      // re-send the parameter for. A cursor carries a position and never a filter (ADR-0064),
      // and the day it carried one would be the day forging one reached a row.
      expect(seen).toEqual(expected);
    },
  );

  it.each(FILTERS)(
    "$path?$parameter reports a cursor while there is more, and none at the end",
    async (filter) => {
      await using kobai = await createTestKobai();
      const merchant = await signInTestMerchant(kobai);
      const arranged = await filter.arrange(kobai, merchant);
      const expected = arranged.matching[filter.paged] ?? [];

      const narrowing = `${filter.parameter}=${filter.paged}`;
      const first = await fetchPageWithCursor(
        kobai,
        filter,
        merchant,
        `?limit=2&${narrowing}`,
      );

      // **A short page is not the end of a list**, which is the clause of ADR-0064 a filter is
      // the first thing on this surface to exercise. This page is shorter than the unfiltered
      // list is long — rows were narrowed away — and it still carries a cursor, because
      // `nextCursor`'s absence is the only end-of-list signal there is.
      expect(first.items).toHaveLength(2);
      expect(
        first.items.length,
        "a filtered page shorter than the whole list",
      ).toBeLessThan(arranged.all.length);
      expect(first.nextCursor).toEqual(expect.any(String));

      const rest = await fetchPageWithCursor(
        kobai,
        filter,
        merchant,
        `?limit=100&${narrowing}&after=${encodeURIComponent(first.nextCursor ?? "")}`,
      );

      expect(rest.items).toEqual(expected.slice(2));
      expect(rest.nextCursor).toBeUndefined();
    },
  );

  /**
   * What makes every case above a guardrail rather than a snapshot.
   *
   * All of it rests on {@link FILTERS} being every filter there is, and {@link FILTERS} is a
   * hand-written table. A route that grew one without an entry would be swept by nothing — its
   * unknown value never offered, its cursor never followed — and the omission is the same manual
   * step whoever added it had already missed. So the table is checked against the description
   * rather than trusted, exactly as `pagination.test.ts` checks `LISTS` (ADR-0049).
   *
   * **A query parameter that is neither `limit` nor `after` is a filter**, which is the whole
   * rule: those two are ADR-0064's and belong to every list, and everything else a route declares
   * is something it narrows by. So a third paging parameter would arrive here as an
   * unaccounted-for filter, which is the right place to have to argue for it — and so would a
   * query parameter on a verb that is not `get`, which is why every operation is read rather than
   * each path's `get`.
   *
   * The checked-in description is the source rather than a freshly built app, because
   * `openapi.test.ts` already holds that file to being what this build produces — asking the
   * router again here would be a second answer to a question that has one.
   *
   * **Watched failing before it was trusted**, in both directions at once: with the
   * `/admin/products` entry rewritten to name a `/admin/orders?state=` that no route declares,
   * this named `/admin/products?status` as declared-and-unswept and `/admin/orders?state` as
   * swept-and-undeclared in one failure.
   *
   * What it deliberately does **not** see is a route that stops declaring a filter it still has
   * an entry for: this reads the checked-in artifact, so a build with
   * `contract.ProductPageQuery` swapped back for `pageQuery("products")` left this case green
   * while four of the cases above went red — and `openapi.test.ts`, whose job that is, would
   * have gone red too. That is the division of labour rather than a gap: this file asks whether
   * the table covers the description, and one file already asks whether the description covers
   * the routes.
   */
  it("is swept for every filter the description declares, and for no others", async () => {
    const described = JSON.parse(
      await readFile(OPENAPI_DOCUMENT_PATH, "utf8"),
    ) as DescribedPaths;

    const declared = Object.entries(described.paths)
      .flatMap(([path, operations]) =>
        Object.values(operations).flatMap((operation) =>
          (operation.parameters ?? [])
            .filter(
              (parameter) => parameter.in === "query" && !PAGING.includes(parameter.name),
            )
            .map((parameter) => `${path}?${parameter.name}`),
        ),
      )
      .sort();

    expect(
      declared.length,
      "the description declares no filter at all, so every sweep in this file is vacuous",
    ).toBeGreaterThan(0);
    // Both directions: a filter missing from `FILTERS` is swept by nothing, and one named here
    // that no route declares would leave every case above passing against a parameter that is
    // gone.
    expect(declared).toEqual(
      FILTERS.map((filter) => `${filter.path}?${filter.parameter}`).sort(),
    );
  });
});

/**
 * A Store holding a Cart in each of the three states, and three of the interesting one.
 *
 * Every Cart is made over the store surface, which is the only way there is to make one — a
 * Merchant reads them and writes none (ADR-0071). The two that are not live are made by the two
 * things that end a Cart: placing it, and letting its deadline pass.
 */
async function arrangeCarts(kobai: TestKobai, merchant: TestSession): Promise<Arranged> {
  const catalog = await seedTestCatalog(kobai, { merchant });

  const live: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    live.push((await seedTestCart(kobai, { catalog })).id);
  }

  const expired = (await seedTestCart(kobai, { catalog })).id;
  // There is no request that makes a day pass, so the deadline is wound back on the row — the
  // way every test in this repository passes time (see the foot of `cart/cart.test.ts`).
  await kobai.database.query(
    `update "core_cart" set "expires_at" = now() - interval '1 hour' where "id" = $1`,
    [expired],
  );

  const spent = (await seedTestOrder(kobai, { catalog })).cart.id;

  // Newest first, which is what the list answers: the placed Cart was started last, then the
  // expired one, then the three live ones in reverse.
  return {
    all: [spent, expired, ...[...live].reverse()],
    matching: { live: [...live].reverse(), expired: [expired], spent: [spent] },
  };
}

/**
 * A catalog holding a Product in each of the three statuses, and three of the interesting one.
 *
 * Every Product is created through `POST /admin/products` — which makes a **draft**, always —
 * and the two that are not drafts are then put where they belong with the same
 * `PATCH /admin/products/{id}` a Merchant publishes and archives with. So the arrangement is
 * itself the two acts stories 6 and 7 ask for, rather than rows written behind the routes.
 */
async function arrangeProducts(
  kobai: TestKobai,
  merchant: TestSession,
): Promise<Arranged> {
  const json = { ...merchant.headers, "content-type": "application/json" };

  const created: string[] = [];
  // One at a time, so `created_at` orders them and the pages below are predictable. A title and
  // a SKU each, because both are unique across the Store — a handle is proposed from the title,
  // so two Products called the same thing are refused `handle-taken`.
  for (let index = 0; index < 5; index += 1) {
    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        title: `Poster ${index}`,
        variants: [{ sku: `POSTER-${index}` }],
      }),
    });
    expect(response.status, `creating Poster ${index}`).toBe(201);
    created.push(((await response.json()) as { id: string }).id);
  }

  const [draft, archived, ...published] = created;
  if (draft === undefined || archived === undefined) {
    throw new Error("unreachable: five Products were created");
  }

  for (const [id, status] of [
    [archived, "archived"],
    ...published.map((id) => [id, "published"] as const),
  ] as const) {
    const moved = await kobai.request(`/admin/products/${id}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ status }),
    });
    expect(moved.status, `putting a Product into ${status}`).toBe(200);
  }

  // Newest first, which is what the list answers.
  return {
    all: [...created].reverse(),
    matching: {
      draft: [draft],
      archived: [archived],
      published: [...published].reverse(),
    },
  };
}
