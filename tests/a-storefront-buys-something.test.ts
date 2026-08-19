import { readFile } from "node:fs/promises";
import { createKobaiClient, type KobaiClient } from "@kobai/client";
import {
  createTestApiKey,
  createTestKobai,
  seedTestCatalog,
  type TestKobai,
} from "@kobai/core/testing";
import { describe, expect, it } from "vitest";

/**
 * A Shopper buys something, over `/store` and through `@kobai/client` — ADR-0069's instrument.
 *
 * kobai's release target is one Shopper journey, written out in that ADR, and **a spec is done
 * when its clause of that sentence passes here**. This file is what "done" is measured with, so
 * it is a guardrail rather than a test of any one route: what each route answers is asserted in
 * the HTTP seam beside it, and what is asserted here is that the answers *compose* into a
 * purchase a Developer could have built.
 *
 * Three things about how it is written are the whole of why it is worth having.
 *
 * **It drives the generated client, not the harness.** `createKobaiClient` takes a `fetch`, so
 * the client dispatches at a really-booted kobai on a real Postgres with no port and no
 * process. That means the journey is type-checked against the published surface: a path that
 * does not exist, a field that is not carried, a body shaped wrongly, all fail
 * `devbox run typecheck` rather than at runtime. ADR-0006 makes the client a deliverable, and
 * until this file existed no Shopper journey was expressed through it at all.
 *
 * **Only the store surface, and a check rather than a convention.** After arrangement the
 * journey may reach `/store` and nothing else — no `/admin`, no `kobai.database`, no Core
 * internals — which is the completeness proof `/admin` has had since ADR-0010 and `/store` has
 * never had. Prior art is `tests/admin-uses-only-the-public-api.test.ts`, which is a separate
 * file because it scans a whole source tree; this one governs a single file, so splitting it
 * would put the rule further from the thing it governs. The line is the marker below, and
 * everything under it is scanned.
 *
 * **Arrangement is free.** A Store has to have something in it before anybody can buy it, and
 * stocking a Store is a Merchant's job — so `/admin` and the harness are used freely up to the
 * marker, exactly as `seedTestCatalog` does. The ban begins where the Shopper does.
 *
 * The sentence being walked, from ADR-0069, with what passes today in **bold**:
 *
 * > A Shopper **browses** a Collection, **opens a product page** and picks an option, **adds it
 * > to a Cart**, **has the stock held**, pays through a bank redirect, and **the Order exists** once
 * > the bank has answered — whether or not the Shopper came back to the tab. The Merchant
 * > dispatches it, and **the Shopper reads it back** dispatched. And the same purchase completes
 * > through the hosted Checkout as through a Developer's own.
 *
 * So the journey walks as far as today's surface allows: browse, open a product page, read a
 * Variant on its own, ask what it costs, fill a Cart and change its mind twice, sign in, hold the
 * stock, place the Order, read it back. It walks **every** operation `/store` serves, and that is derived
 * from the description rather than believed — a route added here without a clause in the
 * journey reddens the build, which is what "later specs extend it" has to mean to be worth
 * anything. Each
 * clause still in plain type is a spec on ADR-0069's list, and **that spec turns its own clause
 * green here** — by extending this file, not by adding a second one and not by asserting it
 * somewhere else. That is what makes "done" a passing test rather than a judgement call.
 */

/** Where the client thinks kobai is. Nothing dials it: `fetch` below answers in-process. */
const BASE_URL = "http://kobai.test";

/** The checked-in description, which `openapi.test.ts` holds to being what this build serves. */
const DESCRIPTION = new URL("../packages/core/openapi.json", import.meta.url);

/**
 * A Store with two Products in it, and the two keys a storefront actually holds.
 *
 * **Two keys, because that is the real pattern** (ADR-0055). The browser gets a publishable
 * one — it is shipped to a page, so it may browse and build a Cart and may not place an Order
 * or read one back — and the server gets a secret one for the purchase leg. A journey that ran
 * on one key would be a journey no storefront could copy.
 *
 * Everything here is arrangement: it seeds through the public admin API, exactly as a Merchant
 * would, and hands back only what a storefront could have been told out of band — a key, and
 * the fact that the Store sells posters.
 */
async function aStoreWithSomethingToSell(kobai: TestKobai): Promise<{
  readonly browser: KobaiClient;
  readonly server: KobaiClient;
}> {
  const posters = await seedTestCatalog(kobai, {
    title: THE_PRODUCT,
    variants: [
      { sku: THE_SKU, prices: [THE_PRICE] },
      { sku: THE_OTHER_SKU, prices: [900] },
    ],
  });

  // A second Product, so browsing is a choice rather than a list of one — and so that opening
  // the right product page is something the journey has to actually do.
  await seedTestCatalog(kobai, {
    merchant: posters.merchant,
    title: "A mug",
    variants: [{ sku: "MUG", prices: [600] }],
  });

  // The copy a Project attaches through ADR-0004's escape hatch, which until catalog breadth
  // lands is the only place a description or an image can live — so it is what a product page
  // is built out of, and the journey reads it back.
  const described = await kobai.request(`/admin/products/${posters.productId}`, {
    method: "PATCH",
    headers: { ...posters.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ metadata: { blurb: BLURB } }),
  });
  expect(described.status, "describing the poster").toBe(200);

  // Counted, because the journey holds this stock before it buys it and a Variant nobody has
  // counted holds nothing at all (ADR-0014). A Merchant counting a shelf is arrangement like
  // everything else above the marker.
  const counted = await kobai.request(
    `/admin/variants/${posters.variant(THE_SKU).id}/inventory`,
    {
      method: "PUT",
      headers: { ...posters.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ onHand: ON_THE_SHELF }),
    },
  );
  expect(counted.status, "counting the posters").toBe(200);

  const publishable = await createTestApiKey(kobai, posters.merchant, {
    name: "the browser's",
    kind: "publishable",
  });

  return {
    browser: clientCarrying(kobai, publishable.key),
    server: clientCarrying(kobai, posters.apiKey.key),
  };
}

/** The generated client, pointed at this instance and carrying one key. */
function clientCarrying(kobai: TestKobai, apiKey: string): KobaiClient {
  return createKobaiClient({
    baseUrl: BASE_URL,
    credential: { apiKey },
    fetch: kobai.fetch,
  });
}

/**
 * What the Store sells, named here so the journey asks for it by name rather than by position.
 *
 * A storefront finds a Product by browsing; asserting on `products[0]` would be this test
 * knowing something a Shopper does not.
 */
const THE_PRODUCT = "A poster";
const THE_SKU = "POSTER-A2";
/** The other size, which the Shopper below adds to the Cart and then thinks better of. */
const THE_OTHER_SKU = "POSTER-A3";
/** Minor units — USD 12.50, and the amount the Order below has to come to twice over. */
const THE_PRICE = 1250;
const BLURB = "Printed on heavy stock.";
const HOW_MANY = 2;
/** What the Store has of it — more than the Shopper takes, so what is held is visible. */
const ON_THE_SHELF = 5;
/** Who the Cart turns out to belong to, once the guest signs in half way through. */
const THE_SHOPPER = "shopper@example.test";

/** What a call answered, or a failure naming the step of the journey that did not complete. */
function answered<Data>(
  reply: { readonly data?: Data; readonly error?: unknown },
  step: string,
): Data {
  if (reply.error !== undefined || reply.data === undefined) {
    throw new Error(`${step} was refused: ${JSON.stringify(reply.error)}`);
  }
  return reply.data;
}

/**
 * The ban, and the line it begins at.
 *
 * A journey that reached `/admin` to find a Product's identifier, or the database to check what
 * it had just done, would pass every assertion below and prove nothing about the store surface
 * — which is exactly the hole ADR-0069 says `/store` has always had. So the rule is checked
 * rather than remembered, over this file's own source, from the marker down.
 *
 * The patterns are written **above** the marker on purpose: the scan would otherwise find its
 * own regular expressions and report the check as the violation.
 *
 * **Watched failing before it was trusted**, against a `kobai.request("/admin/products", …)`
 * spliced into the journey: both sweeps went red and between them named the path, the surface
 * and the dispatcher. An emptiness assertion nobody has seen fail is not yet known to be able
 * to, and a ban is exactly that shape of assertion.
 */
const SHOPPER_BEGINS = "// ---- The Shopper's session begins here";

const FORBIDDEN_AFTER_THE_MARKER: readonly {
  readonly name: string;
  readonly found: RegExp;
}[] = [
  { name: "the admin surface", found: /"\/admin/ },
  { name: "the health endpoint", found: /"\/health/ },
  { name: "the database behind kobai", found: /\.database\b/ },
  // The harness dispatches straight at the application and skips the client, so it skips the
  // one thing this file exists to exercise. Arrangement may use it; the Shopper may not.
  { name: "the harness's own dispatcher", found: /\bkobai\.request\(/ },
  { name: "Core's internals", found: /@kobai\/core/ },
];

async function theShoppersHalfOfThisFile(): Promise<string> {
  const source = await readFile(new URL(import.meta.url), "utf8");
  const marker = source.lastIndexOf(SHOPPER_BEGINS);
  if (marker === -1) throw new Error(`${SHOPPER_BEGINS} is not in this file`);
  return source.slice(marker);
}

/** As much of the description as this file reads: which operations the store surface serves. */
type DescribedPaths = {
  readonly paths: Record<string, Record<string, unknown>>;
};

/** Every operation on `/store`, as `get /store/products` — from the description, not from here. */
async function everyStoreOperation(): Promise<string[]> {
  const described = JSON.parse(await readFile(DESCRIPTION, "utf8")) as DescribedPaths;

  return Object.entries(described.paths)
    .filter(([path]) => path.startsWith("/store"))
    .flatMap(([path, operations]) =>
      Object.keys(operations).map((method) => `${method} ${path}`),
    )
    .sort();
}

/** Every operation the Shopper's half actually calls, read off the client calls it makes. */
function everyOperationTheJourneyDrives(journey: string): string[] {
  const called = [...journey.matchAll(/\.([A-Z]+)\("(\/store[^"]*)"/g)].map(
    (match) => `${(match[1] ?? "").toLowerCase()} ${match[2] ?? ""}`,
  );
  return [...new Set(called)].sort();
}

describe("the Shopper's half of this file reaches only the store surface", () => {
  it("is found, and is the journey rather than a stub", async () => {
    // Every assertion below is over a region of text. A region that was empty, or that had
    // stopped containing the journey, would satisfy all of them and prove none of them.
    const journey = await theShoppersHalfOfThisFile();

    expect(journey.length).toBeGreaterThan(1000);
    // Reads and writes, both through the client and both at the store surface — a region that
    // had lost either would still satisfy the two sweeps below.
    expect(journey).toMatch(/\.GET\("\/store\//);
    expect(journey).toMatch(/\.POST\("\/store\//);
  });

  it("names no path off `/store`, by any spelling", async () => {
    const journey = await theShoppersHalfOfThisFile();

    // Every kobai path the journey mentions, in the template form the client takes them in.
    const named = [...journey.matchAll(/"(\/[^"\s]*)"/g)].map((match) => match[1] ?? "");

    expect(named.length).toBeGreaterThan(5);
    for (const path of named) {
      expect(path.startsWith("/store/"), `${path} is not on the store surface`).toBe(
        true,
      );
    }
  });

  /**
   * That the instrument is **whole**, and stays whole — the half of ADR-0069 a passing journey
   * cannot prove on its own.
   *
   * A journey that walked eight of the surface's operations would be green, would look like a
   * proof, and would leave the ninth exercised by nothing — which is how `/store` came to serve
   * nine operations without one that reads a Product. So the coverage is *derived*: the
   * description says what the store surface serves, this file says what the journey drives, and
   * a store route added without a clause here reddens the build rather than quietly opting out.
   *
   * **Asked of the side this file is not writing** (ADR-0049): the expectation comes from
   * `packages/core/openapi.json`, the checked-in artifact, which `openapi.test.ts` separately
   * holds to being what this build actually serves. A count taken from the journey itself would
   * agree with the journey by construction.
   *
   * It is one direction rather than two. An operation the journey drives is necessarily on the
   * surface — the client would not have typed it otherwise — so the reverse check is the
   * compiler's, and stating it here would be a second answer to a question that has one.
   *
   * **Watched failing before it was trusted**, with the line-item `DELETE` turned into a second
   * `PATCH`: it went red naming `delete /store/carts/{id}/line-items/{lineItemId}` and nothing
   * else, which is the diagnosis a count could not have given.
   */
  it("drives every operation the store surface serves", async () => {
    const served = await everyStoreOperation();
    const driven = everyOperationTheJourneyDrives(await theShoppersHalfOfThisFile());

    // Two empty lists are equal, and an empty description would make this vacuous.
    expect(served.length).toBeGreaterThan(5);
    expect(driven.length).toBeGreaterThan(5);
    // Named rather than counted: a failure says which operation nothing walks, which is the
    // diagnosis. Extra is fine and impossible — a path off the surface fails the sweep above.
    expect(served.filter((operation) => !driven.includes(operation))).toEqual([]);
  });

  it("reaches nothing a storefront could not reach", async () => {
    const journey = await theShoppersHalfOfThisFile();

    const offenders = FORBIDDEN_AFTER_THE_MARKER.filter((forbidden) =>
      forbidden.found.test(journey),
    ).map((forbidden) => `the journey reaches ${forbidden.name}`);

    expect(offenders).toEqual([]);
  });
});

// ---- The Shopper's session begins here -----------------------------------------------------

describe("a Shopper buys something", () => {
  it("browses, opens a product page, builds a Cart and places an Order", async () => {
    await using kobai = await createTestKobai();
    const { browser, server } = await aStoreWithSomethingToSell(kobai);

    // Browsing. A publishable key is the one shipped to a page, and it is enough to see what
    // the Store sells — which is the whole of what this spec added.
    const catalog = answered(
      await browser.GET("/store/products"),
      "browsing the catalog",
    );
    expect(catalog.products.map((one) => one.title).sort()).toEqual([
      "A mug",
      THE_PRODUCT,
    ]);
    // Found by name, the way a Shopper finds it: nothing here knows which row it is.
    const listed = catalog.products.find((one) => one.title === THE_PRODUCT);
    expect(listed, `the Store lists no ${THE_PRODUCT}`).toBeDefined();

    // The product page: one request, and everything on it.
    const page = answered(
      await browser.GET("/store/products/{id}", {
        params: { path: { id: listed?.id ?? "" } },
      }),
      "opening the product page",
    );
    expect(page.title).toBe(THE_PRODUCT);
    // The copy a Project attached. Until catalog breadth lands this bag is the only place a
    // description can live, so a product page that could not read it would not be one.
    expect(page.metadata).toEqual({ blurb: BLURB });
    const chosen = page.variants.find((one) => one.sku === THE_SKU);
    expect(chosen, `${THE_PRODUCT} offers no ${THE_SKU}`).toBeDefined();
    const variantId = chosen?.id ?? "";

    // The same Variant read on its own, which is how a storefront rebuilds a page from a Cart
    // line: a line carries a `variantId` and nothing else.
    const alone = answered(
      await browser.GET("/store/variants/{id}", { params: { path: { id: variantId } } }),
      "reading the Variant on its own",
    );
    expect(alone).toEqual(chosen);

    // What it costs. A separate question because `resolve-price` decides, and a Project may
    // have replaced the Step that chooses — so a storefront asks rather than reading a row.
    const quoted = answered(
      await browser.GET("/store/variants/{id}/price", {
        params: { path: { id: variantId } },
      }),
      "asking what it costs",
    );
    expect(quoted.price.amount).toBe(THE_PRICE);

    // The Cart, built by the browser on its publishable key — the pattern ADR-0020 keeps
    // working, and the reason a Cart's `id` is the whole of the authority to act on it.
    const started = answered(await browser.POST("/store/carts", {}), "starting a Cart");
    const filled = answered(
      await browser.POST("/store/carts/{id}/line-items", {
        params: { path: { id: started.id } },
        body: { variantId },
      }),
      "adding to the Cart",
    );
    expect(filled.lineItems[0]?.variant.sku).toBe(THE_SKU);

    // A Shopper who puts two things in a Cart and then changes their mind about both is the
    // ordinary path rather than the exotic one, and it is what drives the three Cart
    // operations a straight-line purchase never touches. The other size goes in…
    const otherSize = page.variants.find((one) => one.sku === THE_OTHER_SKU);
    const considered = answered(
      await browser.POST("/store/carts/{id}/line-items", {
        params: { path: { id: started.id } },
        body: { variantId: otherSize?.id ?? "" },
      }),
      "adding the other size",
    );
    expect(considered.lineItems).toHaveLength(2);

    // …the first line goes up to two…
    const theLine = considered.lineItems.find((one) => one.variant.sku === THE_SKU);
    const raised = answered(
      await browser.PATCH("/store/carts/{id}/line-items/{lineItemId}", {
        params: { path: { id: started.id, lineItemId: theLine?.id ?? "" } },
        body: { quantity: HOW_MANY },
      }),
      "changing how many",
    );
    expect(raised.lineItems.find((one) => one.variant.sku === THE_SKU)?.quantity).toBe(
      HOW_MANY,
    );

    // …and the other size goes back on the shelf. A removal is a `DELETE` and never a quantity
    // of zero, and it answers with what is left so the page re-renders without a second call.
    const otherLine = considered.lineItems.find(
      (one) => one.variant.sku === THE_OTHER_SKU,
    );
    const trimmed = answered(
      await browser.DELETE("/store/carts/{id}/line-items/{lineItemId}", {
        params: { path: { id: started.id, lineItemId: otherLine?.id ?? "" } },
      }),
      "removing the other size",
    );
    expect(trimmed.lineItems).toHaveLength(1);
    expect(trimmed.lineItems[0]?.quantity).toBe(HOW_MANY);

    // The guest signs in half way through, which is what this route is for. Asserting who the
    // Shopper is needs a **secret** key, so it is the server's call and not the browser's
    // (ADR-0020) — the same split as the purchase leg, arriving one step earlier.
    const known = answered(
      await server.PATCH("/store/carts/{id}", {
        params: { path: { id: started.id } },
        body: { shopper: { email: THE_SHOPPER } },
      }),
      "attaching the Shopper",
    );
    expect(known.shopper?.email).toBe(THE_SHOPPER);

    // Read back on its own, because a storefront re-renders a Cart from a page load rather
    // than from whatever the last mutation happened to answer.
    const reread = answered(
      await browser.GET("/store/carts/{id}", { params: { path: { id: started.id } } }),
      "re-reading the Cart",
    );
    expect(reread.id).toBe(started.id);
    expect(reread.placed).toBe(false);
    expect(reread.lineItems).toHaveLength(1);

    // The stock held, before anybody is sent anywhere to pay (ADR-0070). This is the clause a
    // redirect payment method needs: FPX and its kind take the money at the *bank*, so a
    // Shopper who authorises and comes back to `insufficient-inventory` has paid for something
    // they will not get. A secret key again, for ADR-0055's reason applied to stock: a
    // publishable key in a page could otherwise exhaust a Store's inventory.
    const heldStock = answered(
      await server.POST("/store/carts/{id}/reservations", {
        params: { path: { id: started.id } },
      }),
      "holding the stock",
    );
    expect(heldStock.reservations).toEqual([
      { provider: "inventory", subject: variantId, quantity: HOW_MANY },
    ]);
    // Until when, so a storefront can tell the Shopper how long they have at their bank.
    expect(new Date(heldStock.expiresAt ?? "").getTime()).toBeGreaterThan(Date.now());

    // The purchase leg, on the **secret** key: this is where money and stock move, and a
    // publishable key is refused here (ADR-0055). The browser built the Cart and the server
    // places it, which is the storefront pattern rather than a convenience of the test. It
    // **adopts** the hold above rather than claiming a second one, which is what makes holding
    // early worth anything: the stock the storefront reserved is the stock the Order gets.
    const placed = answered(
      await server.POST("/store/orders", {
        params: { header: { "idempotency-key": "the-journey-buys-a-poster" } },
        body: { cartId: started.id },
      }),
      "placing the Order",
    );
    expect(placed.total).toBe(THE_PRICE * HOW_MANY);
    expect(placed.lineItems[0]?.sku).toBe(THE_SKU);
    // A Step ran, and the response says which. It is what lets a Developer who replaced one
    // see that theirs did (ADR-0017), so a journey that never looked would not be checking it.
    //
    // Narrowed rather than read straight off, and the narrowing is the client doing its job:
    // this route answers **201** for a placement and **200** for a retry carrying an
    // idempotency key that already placed one, and only the first carries an account of a
    // Workflow run. So the types refuse to let the journey assume it placed anything — which
    // is exactly the distinction #102 exists to make — and `undefined` here would mean this
    // request was answered as a replay.
    const account = "workflow" in placed ? placed.workflow : undefined;
    expect(account?.name).toBe("place-order");

    // And read back, so reloading a confirmation page needs no client-side cache. A secret key
    // again: an Order names a Shopper and what they paid, which is not a browser's to read.
    const confirmation = answered(
      await server.GET("/store/orders/{id}", { params: { path: { id: placed.id } } }),
      "reading the Order back",
    );
    expect(confirmation.id).toBe(placed.id);
    expect(confirmation.number).toBe(placed.number);
    expect(confirmation.total).toBe(THE_PRICE * HOW_MANY);
    // And it is the Shopper's rather than a guest's, which is the one thing the Cart learned
    // between being built and being placed.
    expect(confirmation.shopper?.email).toBe(THE_SHOPPER);
  });

  it("refuses the browser's key at the purchase leg, which is why there are two", async () => {
    // The other half of the pattern above, and the reason a storefront cannot simply ship one
    // key: what the browser holds must not be able to buy anything (ADR-0055). Without this,
    // the journey's use of two keys would read as ceremony rather than as a requirement.
    await using kobai = await createTestKobai();
    const { browser } = await aStoreWithSomethingToSell(kobai);

    const started = answered(await browser.POST("/store/carts", {}), "starting a Cart");
    const { error } = await browser.POST("/store/orders", {
      body: { cartId: started.id },
    });

    expect(error).toBeDefined();
    expect(error && "reason" in error ? error.reason : undefined).toBe(
      "secret-key-required",
    );
  });
});
