import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createTestApiKey,
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  seedTestOrder,
  signInTestMerchant,
  type TestApiKey,
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
 * **A list may have more than one filter, and two entries is how that is swept** (#256).
 * `/admin/products` narrows by `status` and by `collection`, and each is held to the convention
 * on its own — which is right, because the promises are about *a* filter rather than about a
 * list. That the two also **compose** is not this file's question: it is a fact about the
 * Product list, and it is asserted in `catalog/collection.test.ts` beside what each of them
 * means.
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
 * The query parameters that are **not filters**, by the operation that declares them (#292).
 *
 * A filter narrows *which rows* a list answers with, and everything in this file is about that:
 * absent means unfiltered, an unknown value is refused rather than ignored, and the narrowing
 * survives a page. `?region=` on the two price routes is a different kind of parameter — it
 * decides *what the answer is* for a single record, and neither route is a list at all: there is
 * no page to keep it across, and "absent means unfiltered" is not even a sentence about it (it
 * means the Store's default Region, which is a value rather than the absence of one).
 *
 * **It is an enumeration rather than a rule, and that is deliberate.** "A parameter on a route
 * that pages nothing" would have read this straight through without anybody thinking, and the
 * next non-filter parameter *should* have to be argued: this file is the one place the surface
 * asks what a query parameter is for. Both halves stay watched — an entry here that no route
 * declares fails the sweep exactly as an unaccounted-for filter does.
 */
const NOT_A_FILTER = [
  "/store/variants/{id}/price?region",
  "/admin/variants/{id}/price?region",
];

/**
 * A deployment arranged for one entry: every row the unfiltered list holds, and which of them
 * each value should answer.
 *
 * **`matching` is a map rather than a partition**, deliberately, and #256 is what that was
 * written for. The first two filters do partition their lists — a Cart is live, expired or
 * spent, and a Product is a draft, published or archived — and `?collection=` does not: a
 * Product may be in several Collections and most are in none, so the values overlap and their
 * union is not the list. Assuming a partition here would have been a rule this convention does
 * not have, written into the one place the next filter has to pass through.
 *
 * **Its keys are the values the entry means to sweep**, which is how an entry names its own: a
 * closed-set filter names three words it wrote down, and `?collection=` names identifiers it has
 * only just created. A value that should narrow to nothing is an explicit `[]`, so "the filter
 * answered nothing" and "the entry forgot to mention the value" are not the same line.
 */
type Arranged = {
  /** Every row of the list, newest first — what the unfiltered page must contain. */
  readonly all: readonly string[];
  /** Per value, the rows that value narrows to, newest first. Its keys are this filter's values. */
  readonly matching: Readonly<Record<string, readonly string[]>>;
  /**
   * The value the two cursor cases walk, which the arrangement has to give at least three rows.
   *
   * On the arrangement rather than on the {@link Filter} beside `unknown`, because #256's is an
   * identifier the arrangement has just created rather than a word anybody could write down —
   * and one field that is sometimes static and sometimes not is a field with two meanings.
   */
  readonly paged: string;
};

/**
 * One filter: which list, which parameter, **which credential opens it**, and how to arrange a
 * deployment where the answer is known.
 *
 * A table rather than a copy of each assertion per filter, so the next one is one entry and is
 * held to the whole convention rather than to a copy of it — which is `pagination.test.ts`'s
 * bargain with `LISTS`, made again about the thing that table deliberately does not cover.
 *
 * **What each value narrows to, and which of them the cursor cases walk, live on the
 * {@link Arranged} an entry produces rather than here** (#256). A closed-set filter could name
 * its three words in this table and `?collection=` cannot: its values are identifiers the
 * arrangement has just created. One field with two meanings is worse than the field being where
 * the answer comes from.
 *
 * `credential` arrived with the first filter on the **store** surface, which is a bearer API
 * key's rather than a Merchant session's (ADR-0020) — the same column `pagination.test.ts` grew
 * for the same reason, and for the same failure: a store list read with a cookie answers 401,
 * which is a plausible-looking failure in a file that is not about credentials at all.
 */
type Filter = {
  readonly path: string;
  /** What this list's rows are called in the envelope it answers with. */
  readonly key: string;
  /** The query parameter, spelled as the route spells it. */
  readonly parameter: string;
  /** Which credential opens this list. */
  readonly credential: "session" | "apiKey";
  /**
   * A value the route does not accept.
   *
   * Named by the entry rather than derived from the description, because a filter's values need
   * not be a closed set: `?collection=` takes an identifier, and what makes a value unusable
   * there — no Collection answers to it — is a different question from what makes `sold-out`
   * unusable on a status.
   */
  readonly unknown: string;
  readonly arrange: (kobai: TestKobai, merchant: TestSession) => Promise<Arranged>;
};

/**
 * A well formed identifier that names no Collection, and never will.
 *
 * A constant rather than a `randomUUID`, because the value is quoted back in the refusal a
 * failure would print.
 */
const ABSENT_COLLECTION = "00000000-0000-4000-8000-000000000000";

const FILTERS: readonly Filter[] = [
  {
    // The filter the convention was inferred from (#227, ADR-0071), and until #252 nothing
    // asserted any of it: `GET /admin/carts?state=` shipped with the three promises above true
    // and untested, which is exactly the drift this file exists to stop.
    path: "/admin/carts",
    key: "carts",
    parameter: "state",
    credential: "session",
    unknown: "abandoned",
    arrange: arrangeCarts,
  },
  {
    // The filter this convention was written down for (#252): a Merchant's way to find their
    // drafts.
    path: "/admin/products",
    key: "products",
    parameter: "status",
    credential: "session",
    unknown: "retired",
    arrange: arrangeProducts,
  },
  {
    // The first filter whose values are not a closed set (#256), and the reason `matching` was
    // always a map: a Product may be in several Collections and most are in none, so these
    // values overlap and their union is not the list.
    path: "/admin/products",
    key: "products",
    parameter: "collection",
    credential: "session",
    unknown: ABSENT_COLLECTION,
    arrange: arrangeCollections,
  },
  {
    // The first entry on the **store** surface, and the reason this table grew a credential
    // column. It is also the one filter here that narrows a list which is *already* narrowed:
    // `/store/products` answers published Products in the route (#252), so what this sweeps is
    // the filter composing with that rather than reaching around it — which is asserted in
    // `catalog/collection.test.ts`, where what a narrowing *means* belongs.
    path: "/store/products",
    key: "products",
    parameter: "collection",
    credential: "apiKey",
    unknown: ABSENT_COLLECTION,
    arrange: arrangeCollections,
  },
];

/**
 * The headers a filter's list is read with, minted on demand from the one Merchant a deployment
 * has.
 *
 * **Lazily**, exactly as `pagination.test.ts`'s is: minting an API key writes a row, and the
 * deployments below that are counting rows are the ones that never ask for a key.
 */
function opener(kobai: TestKobai, merchant: TestSession) {
  let storefront: Promise<TestApiKey> | undefined;

  return async (filter: Filter): Promise<Record<string, string>> => {
    if (filter.credential === "session") return { ...merchant.headers };
    storefront ??= createTestApiKey(kobai, merchant, { name: "a storefront" });
    return (await storefront).headers;
  };
}

/** What {@link opener} hands back: the headers for whichever list is being read. */
type Opener = ReturnType<typeof opener>;

/** One page of one list, with the item key normalised away so the assertions can be shared. */
async function fetchPage(
  kobai: TestKobai,
  filter: Filter,
  open: Opener,
  query = "",
): Promise<{ readonly status: number; readonly items: readonly string[] }> {
  const response = await kobai.request(`${filter.path}${query}`, {
    headers: await open(filter),
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
  open: Opener,
  query: string,
): Promise<{ readonly items: readonly string[]; readonly nextCursor?: string }> {
  const response = await kobai.request(`${filter.path}${query}`, {
    headers: await open(filter),
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
    const open = opener(kobai, merchant);
    const arranged = await filter.arrange(kobai, merchant);

    const unfiltered = await fetchPage(kobai, filter, open, "?limit=100");

    expect(unfiltered.status).toBe(200);
    // Every row, and in the order the list promises — a filter that had somehow reached this
    // request would take rows out of it, which is what nothing narrowing has to mean.
    expect(unfiltered.items).toEqual(arranged.all);
  });

  it.each(FILTERS)("$path?$parameter answers exactly what it names", async (filter) => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const open = opener(kobai, merchant);
    const arranged = await filter.arrange(kobai, merchant);

    // The arrangement's own keys, which is how an entry names the values it means to sweep —
    // three words for a closed set, and identifiers it has just created for `?collection=`.
    const values = Object.keys(arranged.matching);
    expect(
      values.length,
      `${filter.path}?${filter.parameter} arranged no value to narrow by, so this case is vacuous`,
    ).toBeGreaterThan(0);

    for (const value of values) {
      const narrowed = await fetchPage(
        kobai,
        filter,
        open,
        `?limit=100&${filter.parameter}=${value}`,
      );

      const where = `${filter.path}?${filter.parameter}=${value}`;
      expect(narrowed.status, where).toBe(200);
      // Equality rather than a containment check in either direction: a filter that answered
      // too much and one that answered too little are two different bugs and both are here.
      expect(narrowed.items, where).toEqual(arranged.matching[value]);
    }
  });

  it.each(FILTERS)(
    "$path?$parameter refuses a value it does not have, rather than ignoring it",
    async (filter) => {
      await using kobai = await createTestKobai();
      const merchant = await signInTestMerchant(kobai);
      const open = opener(kobai, merchant);
      await filter.arrange(kobai, merchant);

      const response = await kobai.request(
        `${filter.path}?${filter.parameter}=${filter.unknown}`,
        { headers: await open(filter) },
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
      const open = opener(kobai, merchant);
      const arranged = await filter.arrange(kobai, merchant);
      const expected = arranged.matching[arranged.paged] ?? [];
      // The arrangement rather than the subject, so it is asserted rather than assumed: with
      // fewer than three rows the walk below ends on its first page and proves nothing.
      expect(
        expected.length,
        `${filter.path}?${filter.parameter}=${arranged.paged} needs three rows to page through`,
      ).toBeGreaterThanOrEqual(3);

      const narrowing = `${filter.parameter}=${arranged.paged}`;
      const seen: string[] = [];
      let cursor: string | undefined;
      // A page size of one, so every boundary in the filtered list is a boundary between two
      // pages. A bound, so a cursor that never advanced fails here rather than hanging.
      for (let page = 0; page < 20; page += 1) {
        const answered = await fetchPageWithCursor(
          kobai,
          filter,
          open,
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
      const open = opener(kobai, merchant);
      const arranged = await filter.arrange(kobai, merchant);
      const expected = arranged.matching[arranged.paged] ?? [];

      const narrowing = `${filter.parameter}=${arranged.paged}`;
      const first = await fetchPageWithCursor(
        kobai,
        filter,
        open,
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
        open,
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

    const queried = Object.entries(described.paths)
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

    // Subtracted rather than ignored, so the enumeration is held to the description in both
    // directions too: an entry naming a parameter no route declares leaves the two lists
    // unequal, exactly as an unswept filter does.
    const declared = queried.filter((one) => !NOT_A_FILTER.includes(one));
    expect(
      queried.filter((one) => NOT_A_FILTER.includes(one)).sort(),
      "a parameter is named as not a filter and no route declares it",
    ).toEqual([...NOT_A_FILTER].sort());

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
    paged: "live",
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
    paged: "published",
  };
}

/**
 * A catalog grouped into two Collections, one of which holds three Products and one of which
 * holds none — plus a Product in neither, and a Product in both.
 *
 * **The arrangement is where this filter stops looking like the two above.** A status partitions
 * the catalog and a Collection does not, so all three of the shapes that fall out of that are
 * here on purpose: a Product in **two** Collections at once (story 14), a Product in **none**,
 * and a Collection matching **nothing** — which is a value the sweep above still asks for and
 * still expects an exact answer to, because "narrows to nothing" is a real answer and not a
 * missing entry.
 *
 * **Every Product is published, whichever surface is asking.** `/store/products` answers
 * published Products in the route (#252), so a draft would make the store entry's arrangement
 * and the admin entry's disagree about the same rows for a reason that has nothing to do with
 * the filter under test. What the store surface does with a *draft* in a Collection is asserted
 * where a narrowing's meaning belongs, in `catalog/collection.test.ts`.
 */
async function arrangeCollections(
  kobai: TestKobai,
  merchant: TestSession,
): Promise<Arranged> {
  const json = { ...merchant.headers, "content-type": "application/json" };

  const collectionOf = async (title: string): Promise<string> => {
    const response = await kobai.request("/admin/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title }),
    });
    expect(response.status, `creating the ${title} Collection`).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };

  const summer = await collectionOf("Summer");
  const winter = await collectionOf("Winter");
  // A Collection nothing is in, so the sweep above asks for a value that narrows to nothing —
  // which is exactly what a partition-shaped filter never has.
  const empty = await collectionOf("Nothing at all");

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
    const id = ((await response.json()) as { id: string }).id;
    created.push(id);

    // Published, always: `/store/products` answers nothing else, and a Merchant's list answers
    // everything, so this is the one status at which the two entries see the same rows.
    const published = await kobai.request(`/admin/products/${id}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ status: "published" }),
    });
    expect(published.status, `publishing Poster ${index}`).toBe(200);
  }

  const [ungrouped, inBoth, ...inSummer] = created;
  if (ungrouped === undefined || inBoth === undefined) {
    throw new Error("unreachable: five Products were created");
  }

  const group = async (productId: string, collections: readonly string[]) => {
    const response = await kobai.request(`/admin/products/${productId}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ collections: collections.map((id) => ({ id })) }),
    });
    expect(response.status, `grouping ${productId}`).toBe(200);
  };

  await group(inBoth, [summer, winter]);
  for (const id of inSummer) await group(id, [summer]);

  // Newest first, which is what both lists answer — so Summer's is the three later Products in
  // reverse and then the one created before them. `inBoth` is in Winter as well, so the two
  // values overlap, and `ungrouped` is in neither: their union is not the list, which is the
  // property `matching` is a map rather than a partition for.
  return {
    all: [...created].reverse(),
    matching: {
      [summer]: [...[...inSummer].reverse(), inBoth],
      [winter]: [inBoth],
      [empty]: [],
    },
    paged: summer,
  };
}
