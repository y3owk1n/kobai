import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "../db/page.ts";
import {
  createTestApiKey,
  createTestKobai,
  seedTestCatalog,
  seedTestOrder,
  signInTestMerchant,
  type TestKobai,
  type TestSession,
} from "../testing/index.ts";

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

/** What every list answers with, once the item key is set aside. */
type Paged<Item> = {
  readonly items: readonly Item[];
  readonly nextCursor?: string;
};

/**
 * The lists, each as "how to ask for a page of it" and "what its rows are called".
 *
 * A table rather than a copy of each assertion per list, so a list added later is one entry
 * here and is held to the same contract — which is what ADR-0064 means by uniformly. #173's two
 * were exactly that: two entries, and everything below covered them.
 */
const LISTS = [
  { path: "/admin/products", key: "products" },
  { path: "/admin/orders", key: "orders" },
  { path: "/admin/api-keys", key: "apiKeys" },
  { path: "/admin/roles", key: "roles" },
  { path: "/admin/merchants", key: "merchants" },
] as const;

/** One page of one list, with the item key normalised away so the assertions can be shared. */
async function fetchPage(
  kobai: TestKobai,
  list: (typeof LISTS)[number],
  merchant: TestSession,
  query = "",
): Promise<{ readonly status: number } & Paged<{ readonly id: string }>> {
  const response = await kobai.request(`${list.path}${query}`, {
    headers: merchant.headers,
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
  list: (typeof LISTS)[number],
  merchant: TestSession,
  limit: number,
): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  // A bound, so a cursor that never advanced fails here rather than hanging the suite.
  for (let page = 0; page < 20; page += 1) {
    const query = `?limit=${limit}${cursor === undefined ? "" : `&after=${encodeURIComponent(cursor)}`}`;
    const answered = await fetchPage(kobai, list, merchant, query);
    expect(answered.status, `${list.path} page ${page}`).toBe(200);
    seen.push(...answered.items.map((one) => one.id));
    if (answered.nextCursor === undefined) return seen;
    cursor = answered.nextCursor;
  }
  throw new Error(`${list.path} never reported a last page`);
}

/** `count` Products, oldest first — created one at a time, so `created_at` orders them. */
async function seedProducts(
  kobai: TestKobai,
  merchant: TestSession,
  count: number,
): Promise<string[]> {
  const created: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({
        title: `Poster ${index}`,
        variants: [{ sku: `POSTER-${index}` }],
      }),
    });
    expect(response.status, `creating Poster ${index}`).toBe(201);
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
      const seeded = await seedThree(kobai, merchant, list);

      const first = await fetchPage(kobai, list, merchant, "?limit=2");

      expect(first.status).toBe(200);
      // Newest first, which is what all three of these lists promise — so the page is the
      // *last* two seeded, in reverse.
      expect(first.items.map((one) => one.id)).toEqual([seeded[2], seeded[1]]);
      expect(first.nextCursor).toEqual(expect.any(String));

      const rest = await fetchPage(
        kobai,
        list,
        merchant,
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
    await seedThree(kobai, merchant, list);

    const page = await fetchPage(kobai, list, merchant, "?limit=3");

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
      await seedThree(kobai, merchant, list);

      const page = await fetchPage(kobai, list, merchant);

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
      await seedThree(kobai, merchant, list);

      const response = await kobai.request(`${list.path}?limit=${MAX_PAGE_LIMIT + 1}`, {
        headers: merchant.headers,
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

    const response = await kobai.request(`${list.path}?after=not-a-cursor`, {
      headers: merchant.headers,
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

      for (const limit of ["0", "-1", "2.5", "many"]) {
        const response = await kobai.request(`${list.path}?limit=${limit}`, {
          headers: merchant.headers,
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

    const page = await fetchPage(kobai, LISTS[0], merchant);

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
    const merchant = catalog.merchant;
    const seeded: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      seeded.push((await seedTestOrder(kobai, { catalog })).id);
    }

    const first = await fetchPage(kobai, LISTS[1], merchant, "?limit=2");
    expect(first.items.map((one) => one.id)).toEqual([seeded[4], seeded[3]]);

    // The busy hour, in one line: a Shopper places an Order while the Merchant is reading.
    const placed = await seedTestOrder(kobai, { catalog });

    const seen = [...first.items.map((one) => one.id)];
    let cursor = first.nextCursor;
    while (cursor !== undefined) {
      const next = await fetchPage(
        kobai,
        LISTS[1],
        merchant,
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
    const seeded = await seedProducts(kobai, merchant, 3);

    const first = await fetchPage(kobai, LISTS[0], merchant, "?limit=2");
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
      merchant,
      `?limit=2&after=${encodeURIComponent(first.nextCursor ?? "")}`,
    );

    expect(rest.items.map((one) => one.id)).toEqual([seeded[0]]);
  });
});

describe("reading a whole list one page at a time", () => {
  it.each(LISTS)("$path reaches every row of it and stops", async (list) => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const seeded = await seedThree(kobai, merchant, list);

    // A page size of one, so every boundary in the list is a boundary between two pages —
    // which is where a cursor that ties, or an `order by` that does not end in `id`, goes
    // wrong. Three rows and three pages, and the last one is what says there is no fourth.
    const seen = await readToTheEnd(kobai, list, merchant, 1);

    expect(seen).toEqual([...seeded].reverse());
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
  list: (typeof LISTS)[number],
): Promise<string[]> {
  if (list.key === "products") return seedProducts(kobai, merchant, 3);

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
