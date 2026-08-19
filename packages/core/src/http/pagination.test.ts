import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "../db/page.ts";
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
 * Paging a list route — `?limit=`, `?after=`, and a `nextCursor` beside the items (ADR-0064).
 *
 * One file for all three lists rather than three sections in three files, because the point of
 * the scheme is that it is **the same everywhere**: a surface where some lists page and others
 * do not is one a client has to learn twice, and a contract asserted once per route is one that
 * drifts per route. What each list *contains* stays asserted where it always was — this is
 * about the envelope around it.
 *
 * The interesting test is the last one, and it is the whole argument for a cursor: a row
 * inserted between two pages must neither hide a row nor show one twice. That failure needs no
 * contention to reproduce, produces no error, and is invisible in every test that seeds a fixed
 * number of rows and reads them back — which is every other test in this file.
 */

/** As much of the description as this file reads: which operations take an `after`. */
type DescribedPaths = {
  readonly paths: Record<
    string,
    { readonly get?: { readonly parameters?: readonly { readonly name: string }[] } }
  >;
};

/** What every list answers with, once the item key is set aside. */
type Paged<Item> = {
  readonly items: readonly Item[];
  readonly nextCursor?: string;
};

/**
 * The lists, each as "how to ask for a page of it", "what its rows are called", and **which
 * credential opens it**.
 *
 * A table rather than a copy of each assertion per list, so a list added later is one entry
 * here and is held to the same contract — which is what ADR-0064 means by uniformly. #173's two
 * were exactly that: two entries, and everything below covered them.
 *
 * The third column arrived with the first paged list on the **store** surface, which is a
 * bearer API key's rather than a Merchant session's (ADR-0020). Every entry names its own
 * rather than the file assuming one, because "some lists take a session" is exactly the shape
 * of thing that goes wrong silently: a store list read with a cookie answers 401, and a 401 is
 * a plausible-looking failure in a file that is not about credentials at all.
 *
 * `/store/products` and `/admin/products` page the same rows and are two entries, not one. They
 * are two *lists* — two shapes behind two gates, and two cursor names — and the sweep at the
 * foot of this file is what holds that apart: each one's cursor must be refused by the other.
 */
const LISTS = [
  { path: "/admin/products", key: "products", credential: "session" },
  { path: "/admin/orders", key: "orders", credential: "session" },
  { path: "/admin/api-keys", key: "apiKeys", credential: "session" },
  { path: "/admin/roles", key: "roles", credential: "session" },
  { path: "/admin/merchants", key: "merchants", credential: "session" },
  { path: "/admin/carts", key: "carts", credential: "session" },
  { path: "/store/products", key: "products", credential: "apiKey" },
] as const;

type List = (typeof LISTS)[number];

/**
 * The headers a list is read with, minted on demand from the one Merchant a deployment has.
 *
 * **Lazily, and that is not a micro-optimisation.** Minting an API key writes a row to
 * `/admin/api-keys`, which is itself one of the lists below — so a key minted for every test
 * would put a fourth row in a list three of these cases seed exactly three rows into and assert
 * every one of them back. The key is created the first time a store list asks for one, which is
 * never in the deployments that are paging `/admin/api-keys`.
 */
function opener(kobai: TestKobai, merchant: TestSession) {
  let storefront: Promise<TestApiKey> | undefined;

  return async (list: List): Promise<Record<string, string>> => {
    if (list.credential === "session") return { ...merchant.headers };
    storefront ??= createTestApiKey(kobai, merchant, { name: "a storefront" });
    return (await storefront).headers;
  };
}

/** What {@link opener} hands back: the headers for whichever list is being read. */
type Opener = ReturnType<typeof opener>;

/** One page of one list, with the item key normalised away so the assertions can be shared. */
async function fetchPage(
  kobai: TestKobai,
  list: List,
  open: Opener,
  query = "",
): Promise<{ readonly status: number } & Paged<{ readonly id: string }>> {
  const response = await kobai.request(`${list.path}${query}`, {
    headers: await open(list),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return {
    status: response.status,
    items: (body[list.key] ?? []) as readonly { readonly id: string }[],
    nextCursor: body.nextCursor as string | undefined,
  };
}

/** Every page of a list, followed to the end — and the ids in the order they arrived. */
async function readToTheEnd(
  kobai: TestKobai,
  list: List,
  open: Opener,
  limit: number,
): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  // A bound, so a cursor that never advanced fails here rather than hanging the suite.
  for (let page = 0; page < 20; page += 1) {
    const query = `?limit=${limit}${cursor === undefined ? "" : `&after=${encodeURIComponent(cursor)}`}`;
    const answered = await fetchPage(kobai, list, open, query);
    expect(answered.status, `${list.path} page ${page}`).toBe(200);
    seen.push(...answered.items.map((one) => one.id));
    if (answered.nextCursor === undefined) return seen;
    cursor = answered.nextCursor;
  }
  throw new Error(`${list.path} never reported a last page`);
}

/**
 * `count` Products, oldest first — created one at a time, so `created_at` orders them.
 *
 * `mark` distinguishes one batch's SKUs from another's, and it is not decoration: a SKU is
 * unique across the Store, and the cursor sweep at the foot of this file seeds **both** Product
 * lists into one deployment. Two unmarked batches collide on `POSTER-0` and the second is
 * refused `sku-taken`, which is a 409 in the arrangement of a test about paging.
 */
async function seedProducts(
  kobai: TestKobai,
  merchant: TestSession,
  count: number,
  mark = "POSTER",
): Promise<string[]> {
  const created: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({
        title: `Poster ${mark} ${index}`,
        variants: [{ sku: `${mark}-${index}` }],
      }),
    });
    expect(response.status, `creating ${mark} ${index}`).toBe(201);
    created.push(((await response.json()) as { id: string }).id);
  }
  return created;
}

/** `count` Roles, oldest first — created one at a time, so `created_at` orders them. */
async function seedRoles(
  kobai: TestKobai,
  merchant: TestSession,
  count: number,
): Promise<string[]> {
  const created: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await kobai.request("/admin/roles", {
      method: "POST",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: `bookkeeper-${index}` }),
    });
    expect(response.status, `creating bookkeeper-${index}`).toBe(201);
    created.push(((await response.json()) as { id: string }).id);
  }
  return created;
}

/** `count` Merchants, oldest first — colleagues on the `owner` Role, which is what they get. */
async function seedMerchants(
  kobai: TestKobai,
  merchant: TestSession,
  count: number,
): Promise<string[]> {
  const created: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await kobai.request("/admin/merchants", {
      method: "POST",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({
        email: `colleague-${index}@example.test`,
        password: `a colleague's very long password ${index}`,
      }),
    });
    expect(response.status, `creating colleague-${index}`).toBe(201);
    created.push(((await response.json()) as { id: string }).id);
  }
  return created;
}

/** The identifier of a Role this deployment already has, read back through the list itself. */
async function roleNamed(
  kobai: TestKobai,
  merchant: TestSession,
  name: string,
): Promise<string> {
  const response = await kobai.request("/admin/roles", { headers: merchant.headers });
  const { roles } = (await response.json()) as { roles: { id: string; name: string }[] };
  const found = roles.find((role) => role.name === name);
  if (!found) throw new Error(`no Role named ${name} exists`);
  return found.id;
}

describe("every list route pages, and pages the same way", () => {
  it.each(LISTS)(
    "$path answers the page it was asked for, then what follows it",
    async (list) => {
      await using kobai = await createTestKobai();
      const merchant = await signInTestMerchant(kobai);
      const open = opener(kobai, merchant);
      const seeded = await seedThree(kobai, merchant, list);

      const first = await fetchPage(kobai, list, open, "?limit=2");

      expect(first.status).toBe(200);
      // Newest first, which is what all three of these lists promise — so the page is the
      // *last* two seeded, in reverse.
      expect(first.items.map((one) => one.id)).toEqual([seeded[2], seeded[1]]);
      expect(first.nextCursor).toEqual(expect.any(String));

      const rest = await fetchPage(
        kobai,
        list,
        open,
        `?limit=2&after=${encodeURIComponent(first.nextCursor ?? "")}`,
      );

      expect(rest.items.map((one) => one.id)).toEqual([seeded[0]]);
      // The end of the list, and the only signal of it there is: not a short page, which a
      // filtered list will produce in the middle the day these routes filter.
      expect(rest.nextCursor).toBeUndefined();
    },
  );

  it.each(LISTS)("$path reports no cursor when everything fits", async (list) => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const open = opener(kobai, merchant);
    await seedThree(kobai, merchant, list);

    const page = await fetchPage(kobai, list, open, "?limit=3");

    // Exactly as many rows as there are, which is the case a `limit + 1` fetch exists to tell
    // from a full page with more behind it.
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeUndefined();
  });

  it.each(LISTS)(
    "$path answers a first page to a caller that asks nothing",
    async (list) => {
      await using kobai = await createTestKobai();
      const merchant = await signInTestMerchant(kobai);
      const open = opener(kobai, merchant);
      await seedThree(kobai, merchant, list);

      const page = await fetchPage(kobai, list, open);

      // Both parameters are optional, which is what made adding them additive: a client written
      // before this existed sends neither and is answered rather than refused.
      expect(page.status).toBe(200);
      expect(page.items).toHaveLength(3);
    },
  );

  it.each(LISTS)(
    "$path refuses a limit above the ceiling rather than reducing it",
    async (list) => {
      await using kobai = await createTestKobai();
      const merchant = await signInTestMerchant(kobai);
      const open = opener(kobai, merchant);
      await seedThree(kobai, merchant, list);

      const response = await kobai.request(`${list.path}?limit=${MAX_PAGE_LIMIT + 1}`, {
        headers: await open(list),
      });

      // Refused, not clamped. A caller that asked for 5,000 and received a hundred reads the
      // short page as the end of the list and stops — which is the silent wrongness the whole
      // scheme is here to avoid, arriving through the parameter instead of through the query.
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
    },
  );

  it.each(LISTS)("$path refuses an `after` it did not issue", async (list) => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const open = opener(kobai, merchant);

    const response = await kobai.request(`${list.path}?after=not-a-cursor`, {
      headers: await open(list),
    });

    // Refused rather than treated as the first page: a caller handed a cursor kobai will not
    // read would otherwise page the same rows again forever and never be told why.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });

  it.each(LISTS)(
    "$path refuses a limit that is not a whole number of rows",
    async (list) => {
      await using kobai = await createTestKobai();
      const merchant = await signInTestMerchant(kobai);
      const open = opener(kobai, merchant);

      for (const limit of ["0", "-1", "2.5", "many"]) {
        const response = await kobai.request(`${list.path}?limit=${limit}`, {
          headers: await open(list),
        });

        expect(response.status, `limit=${limit}`).toBe(400);
      }
    },
  );
});

describe("the default page size", () => {
  it("is what a caller who names no limit gets, and there is more behind it", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    // One more than the default, which is the smallest arrangement that can tell a default
    // from "everything there is" — the assertion this file would otherwise not be making.
    await seedProducts(kobai, merchant, DEFAULT_PAGE_LIMIT + 1);

    const page = await fetchPage(kobai, LISTS[0], opener(kobai, merchant));

    expect(page.items).toHaveLength(DEFAULT_PAGE_LIMIT);
    expect(page.nextCursor).toEqual(expect.any(String));
  });
});

describe("a page fetched across a concurrent insert", () => {
  /**
   * The one assertion that distinguishes this scheme from `limit`/`offset`, and the reason
   * ADR-0064 was written before any list was long.
   *
   * **Watched failing before it was made to pass**, against `listOrders` rewritten to page by
   * offset — the cursor carrying a row count and the query taking `.offset()`. With an Order
   * placed between page 1 and page 2, six ids came back where five were seeded: the Order at
   * the bottom of page 1 arrived again at the top of page 2, because the sixth Order had pushed
   * every row down by one and page 2 resumed at a *position* rather than after a record. Every
   * request answered 200 and nothing was logged, which is the whole problem. Restoring the
   * cursor made it green.
   *
   * A duplicate rather than a skip is what a **`desc` sort and an insert** produce together, and
   * the mirror image is worth knowing: a row *deleted* while paging pulls the next one up past
   * the boundary, and it is then never shown at all. Both are the same defect — a position is
   * not a place — and a cursor answers neither by being careful.
   *
   * Orders rather than Products, because Orders are the table guaranteed to take concurrent
   * inserts in production: every `POST /store/orders` a storefront makes is one, and a Merchant
   * paging through them during a busy hour is the ordinary case rather than the pathological
   * one. The insert here goes through that same route.
   */
  it("shows every Order that already existed exactly once", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const open = opener(kobai, catalog.merchant);
    const seeded: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      seeded.push((await seedTestOrder(kobai, { catalog })).id);
    }

    const first = await fetchPage(kobai, LISTS[1], open, "?limit=2");
    expect(first.items.map((one) => one.id)).toEqual([seeded[4], seeded[3]]);

    // The busy hour, in one line: a Shopper places an Order while the Merchant is reading.
    const placed = await seedTestOrder(kobai, { catalog });

    const seen = [...first.items.map((one) => one.id)];
    let cursor = first.nextCursor;
    while (cursor !== undefined) {
      const next = await fetchPage(
        kobai,
        LISTS[1],
        open,
        `?limit=2&after=${encodeURIComponent(cursor)}`,
      );
      seen.push(...next.items.map((one) => one.id));
      cursor = next.nextCursor;
    }

    // Every Order that existed when paging began, exactly once, still newest first. The whole
    // sequence rather than a count of it: a skip and a duplicate cancel each other out in a
    // number, and they are the two things this is looking for.
    expect(seen).toEqual([...seeded].reverse());
    // And the Order placed midway is not among them — it belongs above the page already read,
    // and a cursor answers what follows a record rather than what sits at a position.
    expect(seen).not.toContain(placed.id);
  });
});

describe("paging is stable when the row a cursor names is deleted", () => {
  it("still answers what followed it", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const open = opener(kobai, merchant);
    const seeded = await seedProducts(kobai, merchant, 3);

    const first = await fetchPage(kobai, LISTS[0], open, "?limit=2");
    expect(first.items.map((one) => one.id)).toEqual([seeded[2], seeded[1]]);

    // The row the cursor was cut from, gone. A cursor that named a row by identifier and looked
    // it up would find nothing here and report the end of a list that has not ended — so this
    // is a test about what a cursor is made of, which is the one thing about it that is not
    // promised and therefore the one thing worth pinning here rather than in a client.
    const deleted = await kobai.request(`/admin/products/${seeded[1]}`, {
      method: "DELETE",
      headers: merchant.headers,
    });
    expect(deleted.status).toBe(204);

    const rest = await fetchPage(
      kobai,
      LISTS[0],
      open,
      `?limit=2&after=${encodeURIComponent(first.nextCursor ?? "")}`,
    );

    expect(rest.items.map((one) => one.id)).toEqual([seeded[0]]);
  });
});

describe("reading a whole list one page at a time", () => {
  it.each(LISTS)("$path reaches every row of it and stops", async (list) => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const open = opener(kobai, merchant);
    const seeded = await seedThree(kobai, merchant, list);

    // A page size of one, so every boundary in the list is a boundary between two pages —
    // which is where a cursor that ties, or an `order by` that does not end in `id`, goes
    // wrong. Three rows and three pages, and the last one is what says there is no fourth.
    const seen = await readToTheEnd(kobai, list, open, 1);

    expect(seen).toEqual([...seeded].reverse());
  });
});

describe("a cursor is bound to the list that issued it", () => {
  /**
   * The failure this is written against answered **200**, which is the whole reason it needs a
   * test: a cursor cut from Products decoded on Orders, satisfied the schema, and came back as
   * a plausible page of the wrong list. Nothing in the payload said which reader had written
   * it, so nothing could tell a Merchant paging Orders from a Merchant who pasted a URL from
   * another tab (#183).
   *
   * **Every ordered pair rather than one example**, because the property is about the set: what
   * makes a cursor unusable elsewhere is that no two lists name themselves the same thing, and
   * a duplicate name is exactly what a single pair would miss. One deployment for all of them —
   * the pairs are twenty requests and twenty deployments would be twenty boots.
   *
   * **Watched failing before it was made to pass**, against the cursor as #171 shipped it —
   * `at` and `id` and nothing else. All twenty pairs answered **200**, in the two shapes that
   * are each worse than the other. Eighteen were a real page of the list that had not issued
   * the cursor — Roles, Merchants and Orders read through a Product's position, several of them
   * carrying a `nextCursor` of their own, so paging on from there was an ordinary loop. The
   * other two came back `{"orders": []}` and `{"apiKeys": []}` with no cursor at all, because
   * a Product's position was older than every row of those lists: the caller is told the list
   * has **ended**. Neither answer is distinguishable from a correct one by the client holding
   * it, which is why nothing but a test from outside was ever going to find this.
   *
   * **Watched failing again** when `/store/products` joined the table, against that route
   * declaring `pageQuery("products")` — the name the Merchant's Product list already uses. One
   * pair went red: `/admin/products`'s cursor answered a 200 page of `/store/products`. Two
   * lists over one table is the most tempting collision there is, and this is the only thing
   * that can see it.
   */
  it("is refused by every other list rather than answering a page of it", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const open = opener(kobai, merchant);

    const cursors = new Map<string, string>();
    for (const list of LISTS) {
      await seedThree(kobai, merchant, list);
      const page = await fetchPage(kobai, list, open, "?limit=1");
      // The arrangement rather than the subject, so it is asserted rather than assumed: a list
      // that issued no cursor would make every pair below vacuously green.
      expect(page.nextCursor, `${list.path} issued no cursor to offer elsewhere`).toEqual(
        expect.any(String),
      );
      cursors.set(list.path, page.nextCursor ?? "");
    }

    for (const issuer of LISTS) {
      for (const reader of LISTS) {
        if (issuer.path === reader.path) continue;
        const cursor = cursors.get(issuer.path) ?? "";

        const response = await kobai.request(
          `${reader.path}?limit=1&after=${encodeURIComponent(cursor)}`,
          { headers: await open(reader) },
        );

        const where = `${issuer.path}'s cursor offered to ${reader.path}`;
        expect(response.status, where).toBe(400);
        // The existing `invalid` rather than a `reason` of its own, which is #183's decision
        // and is argued in `db/page.ts`: both this and a cursor kobai never wrote mean the
        // same thing to a client, and a new reason would be permanent under ADR-0060.
        await expect(response.json(), where).resolves.toMatchObject({
          reason: "invalid",
        });
      }
    }

    // And the other half of the same fact, over the same deployment: refusing every cursor
    // everywhere would satisfy every assertion above and be a surface no list can be paged on
    // at all. The pair is what makes this a binding rather than a wall.
    for (const list of LISTS) {
      const own = await fetchPage(
        kobai,
        list,
        open,
        `?limit=1&after=${encodeURIComponent(cursors.get(list.path) ?? "")}`,
      );

      const here = `${list.path}'s own cursor, on ${list.path}`;
      expect(own.status, here).toBe(200);
      expect(own.items, here).toHaveLength(1);
    }
  });

  /**
   * What makes the sweep above a guardrail rather than a snapshot, and what `db/page.ts` is
   * entitled to claim when it says a **collision** in `PagedList` is caught here.
   *
   * That claim rests on `LISTS` being every paged list there is, and `LISTS` is a hand-written
   * table. A list route added without an entry would be swept by nothing — its cursor never
   * offered anywhere, its name never held against the others — and the omission is
   * the same manual step whoever added it had already missed. So the table is checked against
   * the description rather than trusted, the way this repository derives such a list rather
   * than writing one down (ADR-0049).
   *
   * **`after` is what identifies a paged route**, because it is what ADR-0064 makes one: a
   * route that takes a cursor is a route that issues one. `GET /admin/fulfilment-strategies`
   * takes neither and is ADR-0067's deliberate exception, so it is absent from both sides and
   * needs no excuse here.
   *
   * The checked-in description is the source rather than a freshly built app, because
   * `openapi.test.ts` already holds that file to being what this build produces — asking the
   * router again here would be a second answer to a question that has one.
   */
  it("is swept for every list the description says pages, and for no others", async () => {
    const described = JSON.parse(
      await readFile(OPENAPI_DOCUMENT_PATH, "utf8"),
    ) as DescribedPaths;

    const paged = Object.entries(described.paths)
      .filter(([, operations]) =>
        operations.get?.parameters?.some((parameter) => parameter.name === "after"),
      )
      .map(([path]) => path)
      .sort();

    expect(
      paged.length,
      "the description carries no paged list route at all, so every sweep here is vacuous",
    ).toBeGreaterThan(0);
    // Both directions: a list route missing from `LISTS` is swept by nothing, and one named
    // here that no longer exists would leave every case above passing against a path that is
    // gone.
    expect(paged).toEqual(LISTS.map((list) => list.path).sort());
  });
});

/**
 * Three rows of whichever list is under test, oldest first — Products, Orders or API keys.
 *
 * One arrangement per list rather than one test per list, so the contract above is asserted in
 * the same words for all three. Everything goes through the public API, like the rest of this
 * repository: a row inserted behind the routes would be a row no Merchant could have made.
 *
 * **Three rows and exactly three**, which is why each branch seeds only what its own list
 * counts. Arranging an Order takes a Product and an API key with it, so seeding all three
 * lists at once would leave two of them holding rows the test never asked for and could not
 * name.
 */
async function seedThree(
  kobai: TestKobai,
  merchant: TestSession,
  list: List,
): Promise<string[]> {
  // Both Product lists seed through `/admin/products`, because that is the only way to make a
  // Product — the store surface reads the catalog and writes none of it. They take a mark each
  // so that the two batches the cursor sweep seeds into one deployment do not collide on a SKU.
  if (list.key === "products") {
    return seedProducts(
      kobai,
      merchant,
      3,
      list.path.startsWith("/store") ? "STOREFRONT" : "POSTER",
    );
  }

  // Two of these lists start with a row already in them — the `owner` Role a migration seeds
  // and the first Merchant a boot does — so they get **two** more rather than three, and the
  // one that was already there is the oldest and therefore the first of the three.
  if (list.key === "roles")
    return [
      await roleNamed(kobai, merchant, "owner"),
      ...(await seedRoles(kobai, merchant, 2)),
    ];
  if (list.key === "merchants") {
    return [merchant.merchant.id, ...(await seedMerchants(kobai, merchant, 2))];
  }

  const seeded: string[] = [];
  // Three Carts over the store surface, which is the only way there is to make one — a Merchant
  // reads them and writes none of them (ADR-0071). One catalog behind all three, under a SKU of
  // its own: the cursor sweep seeds every list into one deployment, and the Orders branch seeds
  // a catalog too, so two default ones would collide on `POSTER-A2` and be refused `sku-taken`.
  if (list.key === "carts") {
    const catalog = await seedTestCatalog(kobai, {
      merchant,
      variants: [{ sku: "CART-POSTER", prices: [1250] }],
    });
    for (let index = 0; index < 3; index += 1) {
      seeded.push((await seedTestCart(kobai, { catalog })).id);
    }
    return seeded;
  }

  if (list.key === "orders") {
    const catalog = await seedTestCatalog(kobai, { merchant });
    for (let index = 0; index < 3; index += 1) {
      seeded.push((await seedTestOrder(kobai, { catalog })).id);
    }
    return seeded;
  }

  for (let index = 0; index < 3; index += 1) {
    seeded.push((await createTestApiKey(kobai, merchant, { name: `key ${index}` })).id);
  }
  return seeded;
}
