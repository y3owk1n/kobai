import { readFile } from "node:fs/promises";
import { createKobaiClient, type KobaiClient } from "@kobai/client";
import {
  createTestApiKey,
  createTestKobai,
  seedTestCatalog,
  type TestKobai,
  type TestSession,
} from "@kobai/core/testing";
import { describe, expect, it } from "vitest";
import referenceConfig from "../reference/kobai.config.ts";
import { createAdminAssets } from "../reference/src/admin-assets.ts";
import { createProjectFetch, type ProjectFetch } from "../reference/src/app.ts";
import { createFakeBank, type FakeBank } from "../reference/src/payments/fake-bank.ts";
import {
  createRedirectPaymentRoutes,
  REDIRECT_CALLBACK_PATH,
  REDIRECT_RETURN_PATH,
  REDIRECT_START_PATH,
} from "../reference/src/payments/redirect.ts";

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
 * `pnpm run typecheck` rather than at runtime. ADR-0006 makes the client a deliverable, and
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
 * **The one thing the journey reaches that is not kobai is the Developer's own server**, and it
 * arrived with the bank redirect (ADR-0070). A payment the Shopper completes at their bank is
 * settled by a route the *Project* mounts — a Plugin cannot add one, and signature verification
 * and logging are the deployment's to own — so the redirect leg below posts at
 * `reference/src/payments/redirect.ts` and that route calls `POST /store/orders` like any other
 * client. It is not a hole in the ban and it is not exempt from it: the Project's paths reach
 * this file as **imported constants**, so every kobai path the journey names is still a literal
 * the sweep reads, and `reference/src/app.test.ts` holds that Project route to adding nothing
 * whatever to the API it is served beside.
 *
 * **Arrangement is free.** A Store has to have something in it before anybody can buy it, and
 * stocking a Store is a Merchant's job — so `/admin` and the harness are used freely up to the
 * marker, exactly as `seedTestCatalog` does. The ban begins where the Shopper does. **So is the
 * clock**: there is no request that makes fifteen minutes have passed, so the hold below is
 * lapsed by winding its row back, the way every window in this repository is tested, and that
 * one line lives above the marker with the rest of the arrangement.
 *
 * That is worth saying plainly, because it is also the way the ban could be got round: the sweep
 * reads this file's **text** below the marker, so anything a helper declared above it does is
 * invisible to it. Four helpers are called from below — `aStoreWithSomethingToSell` and
 * `aStoreThatTakesBankRedirects`, which stock the Store, `theHoldLapses`, which is the clock, and
 * `theMerchantDispatches`, which is the **Merchant** doing a Merchant's job — and none may grow
 * into a storefront doing something a storefront could not. **Arranging and acting are the
 * line**: if a helper up here starts doing what the Shopper is supposed to be doing, move it down
 * and let the sweep judge it.
 *
 * **The fourth is the one worth pausing on**, because it happens *after* the Shopper has bought
 * something rather than before. It is still arrangement, and the test is whose job it is: posting
 * a parcel is the Merchant's, exactly as stocking the shelf was, and a Shopper has no route that
 * dispatches anything and must not. What the Shopper does with it — reading their own Order back
 * and seeing it has gone — is below the marker, over `/store`, through the client, where the
 * sweep can judge it.
 *
 * The sentence being walked, from ADR-0069, with what passes today in **bold**:
 *
 * > A Shopper **browses a Collection**, **opens a product page** and **picks an option**, **adds
 * > it to a Cart**, **has the stock held**, **pays through a bank redirect**, and **the Order
 * > exists once the bank has answered — whether or not the Shopper came back to the tab**. **The
 * > Merchant dispatches it**, and **the Shopper reads it back dispatched**. And the same purchase
 * > completes through the hosted Checkout as through a Developer's own.
 *
 * So the journey walks as far as today's surface allows: browse the catalog, follow one of the
 * Collections a Product reports, open the product page at the handle that Collection listed,
 * choose a value for every option the Product declares and resolve that combination to a SKU,
 * read that Variant on its own, ask what it costs, fill a Cart and change its mind twice, sign
 * in, hold the stock, place the Order, read it back — and then walks the purchase a second way,
 * through a bank, three times over: the Shopper who comes back, the Shopper who never does, and
 * the hold that lapsed while they were away. The last two are what ADR-0069 says this instrument is
 * *better* than a browser for: "the callback arrives and the return never does" is two calls and
 * one that is never made. It walks **every** operation `/store` serves, and that is derived
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
 * A Store a Merchant has actually stocked, and the two keys a storefront actually holds.
 *
 * **Two keys, because that is the real pattern** (ADR-0055). The browser gets a publishable
 * one — it is shipped to a page, so it may browse and build a Cart and may not place an Order
 * or read one back — and the server gets a secret one for the purchase leg. A journey that ran
 * on one key would be a journey no storefront could copy.
 *
 * **Four Products, and every one of them is here to stop an assertion below passing for the
 * wrong reason.** A poster, grouped into a Collection, declaring two options and carrying three
 * Variants across them; a mug, in no Collection, so browsing one is a narrowing rather than a
 * list of everything; and two Products the Merchant has **not** published — a draft and an
 * archived one, both put *into* the Collection, so their absence from it is the store surface's
 * filter working rather than the Merchant having forgotten to group them.
 *
 * **The grid is deliberately incomplete and deliberately ambiguous one option at a time.** The
 * Store sells A2 in Matte, A2 in Glossy and A3 in Matte, and no A3 in Glossy. So a resolution
 * that matched a single value would have two Variants to choose between and could take either,
 * and a combination nobody made is simply absent — which is what the whole payload travelling to
 * the page is for.
 *
 * Everything here is arrangement: it seeds through the public admin API, exactly as a Merchant
 * would, and hands back only what a storefront could have been told out of band — a key, and
 * the fact that the Store sells posters.
 */
async function aStoreWithSomethingToSell(kobai: TestKobai): Promise<{
  readonly browser: KobaiClient;
  readonly server: KobaiClient;
  /**
   * The Merchant who stocked it, handed back so the journey can ask them to post the parcel.
   *
   * It is a session on the **admin** surface and is used for nothing else: the only thing below
   * the marker that touches it is `theMerchantDispatches`, and every kobai path that helper names
   * is written up here where the sweep expects `/admin` to appear.
   */
  readonly merchant: TestSession;
}> {
  // Most of a product page in one call (#281): the copy a Merchant wrote, the Collection the
  // posters are grouped under, and the options this Product is chosen by — which
  // `seedTestCatalog` declares by reading them off the Variants, so a Variant answering an
  // option this Product does not declare is not an arrangement that can be written down here.
  const posters = await seedTestCatalog(kobai, {
    title: THE_PRODUCT,
    description: THE_DESCRIPTION,
    // A storefront's navigation is built out of the Collections the Products it read report, so
    // nothing on the store surface enumerates these and the journey never asks it to.
    collections: [THE_COLLECTION],
    variants: THE_GRID.map(({ sku, price, options }) => ({
      sku,
      prices: [price],
      options,
    })),
  });
  const json = { ...posters.merchant.headers, "content-type": "application/json" };
  const collection = posters.collection(THE_COLLECTION);

  // A second Product, so browsing is a choice rather than a list of one — and so that opening
  // the right product page is something the journey has to actually do. In no Collection, so
  // that browsing one below narrows the catalog rather than answering all of it again.
  await seedTestCatalog(kobai, {
    merchant: posters.merchant,
    title: "A mug",
    variants: [{ sku: "MUG", prices: [600] }],
  });

  // Two Products a Shopper must never meet, **in that same Collection**: one still being
  // written and one taken off sale. The Collection is handed over rather than named again,
  // because two Collections may share a title and naming it would make a second one.
  for (const unpublished of THE_UNPUBLISHED) {
    const prepared = await seedTestCatalog(kobai, {
      merchant: posters.merchant,
      title: unpublished.title,
      status: unpublished.status,
      collections: [collection],
      variants: [{ sku: unpublished.sku, prices: [700] }],
    });
    // Their handles are named rather than proposed, because the journey then asks for each by
    // the address a Merchant might have shared. It is a `PATCH` on purpose: `seedTestCatalog`
    // passes no handle of its own, so every catalog it seeds exercises the proposal instead.
    const addressed = await kobai.request(`/admin/products/${prepared.productId}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ handle: unpublished.handle }),
    });
    expect(addressed.status, `addressing ${unpublished.title}`).toBe(200);
  }

  // The last thing a product page is made of: the bag a Project attaches its own through
  // (ADR-0004), which is not something a seeded catalog carries.
  const described = await kobai.request(`/admin/products/${posters.productId}`, {
    method: "PATCH",
    headers: json,
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
      headers: json,
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
    merchant: posters.merchant,
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
 * The same Store, deployed by somebody who takes payments at a bank — the arrangement the three
 * redirect cases start from.
 *
 * **It is the reference Project, booted**, rather than bare Core with a provider bolted on:
 * `kobai.config.ts`, its Plugins, its replaced pricing Step and its own migration set, which is
 * what makes this Store price in **MYR** — the currency FPX settles in, and the reason ADR-0069
 * moved it off the placeholder dollars every amount in this repository used to be in. So the
 * figures below are this deployment's own (`everything-costs-one-cent` decides them), which is
 * the sharper version of ADR-0077's guarantee: what the Shopper authorises at the bank is what
 * *this* Project charges, not what the catalog happens to say.
 *
 * **One object is the bank and the Payment Provider**, and it has to be: the thing that starts a
 * payment and the thing kobai asks to confirm it are the same system, or `charge` is confirming
 * somebody else's money. That is the shape `stripePayments` already has, and the one line
 * `kobai.config.ts` moves on the day this Store takes cards.
 *
 * The fake is the artefact ADR-0070 asks for. Stripe's sandbox cannot be told to abandon, and it
 * cannot be told that fifteen minutes have gone by; both of those are a method call here.
 */
type ARedirectStore = {
  readonly kobai: TestKobai;
  /** The page's key: browsing, the Cart, and asking what it comes to. */
  readonly browser: KobaiClient;
  /** The storefront's server key: holding stock and reading an Order back (ADR-0055). */
  readonly server: KobaiClient;
  /** The bank, which is also this deployment's Payment Provider. */
  readonly bank: FakeBank;
  /** The Developer's own server — this Project, serving the routes it mounts itself. */
  readonly project: ProjectFetch;
  /** What the Store sells here, found by browsing rather than handed over. */
  readonly variantId: string;
};

async function aStoreThatTakesBankRedirects(): Promise<ARedirectStore> {
  const bank = createFakeBank();
  const kobai = await createTestKobai({
    ...referenceConfig,
    payments: { provider: bank },
  });

  const posters = await seedTestCatalog(kobai, {
    title: THE_PRODUCT,
    variants: [{ sku: THE_SKU, prices: [THE_PRICE] }],
  });
  const counted = await kobai.request(
    `/admin/variants/${posters.variant(THE_SKU).id}/inventory`,
    {
      method: "PUT",
      headers: { ...posters.merchant.headers, "content-type": "application/json" },
      // Exactly what the Shopper below takes, so that a hold which lapses is a hold nothing
      // else can be sold past — which is the state a Shopper meets when they come back from a
      // bank late, and the only one in this whole design that takes money and gives no goods.
      body: JSON.stringify({ onHand: THE_LAST_OF_THEM }),
    },
  );
  expect(counted.status, "counting the posters").toBe(200);

  const publishable = await createTestApiKey(kobai, posters.merchant, {
    name: "the browser's",
    kind: "publishable",
  });

  return {
    kobai,
    browser: clientCarrying(kobai, publishable.key),
    server: clientCarrying(kobai, posters.apiKey.key),
    bank,
    variantId: posters.variant(THE_SKU).id,
    project: createProjectFetch(
      { fetch: kobai.fetch },
      createAdminAssets(),
      createRedirectPaymentRoutes({
        kobai: { fetch: kobai.fetch },
        payments: bank,
        // A **secret** key, because the route it settles with places Orders (ADR-0055). It is
        // the storefront's server-side credential and never the page's.
        apiKey: posters.apiKey.key,
      }),
    ),
  };
}

/**
 * A `POST` at the Developer's own server, which is what both halves of a bank's answer are.
 *
 * The Shopper's browser is redirected back and posts what it was given; the bank posts its own
 * event. Neither is kobai, and neither is in `@kobai/client` — a Project's routes are the
 * Project's, which is the whole of why ADR-0070 puts them there.
 */
async function postedAt(
  project: ProjectFetch,
  path: string,
  body: unknown,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await project(
    new Request(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/**
 * Fifteen minutes go by while the Shopper is in their banking app.
 *
 * **The clock is arrangement, and this is the only honest way to move it.** There is no request
 * that makes a window have elapsed, and a test that waited for a real one would wait a minute at
 * the very least — Core's floor, and the floor is there because a hold has to outlive the
 * placement that took it (ADR-0075). So the row is wound back, exactly as every session window
 * in this repository is tested, and the sweeper has simply not come round yet: a hold that
 * lapsed a moment ago is still holding its units, so the placement can neither adopt it nor
 * claim past it. That is precisely the state a Shopper meets when they take too long.
 */
async function theHoldLapses(kobai: TestKobai): Promise<void> {
  await kobai.database.query(
    "update core_reservation set expires_at = now() - interval '1 minute' where released_at is null",
  );
}

/**
 * **The Merchant posts the parcel** — the clause of ADR-0069's sentence that is nobody's but
 * theirs (#320).
 *
 * Arrangement, and above the marker for the same reason stocking the shelf is: a Shopper has no
 * route that dispatches anything and must never have one. What makes it arrangement rather than a
 * hole in the ban is *whose* act it is, not when it happens — the ban is about a journey reaching
 * `/admin` to find out something a storefront could not know, and everything this reads is
 * already in the Order the Shopper is holding.
 *
 * It reads the Order back over `/admin` first, exactly as a Merchant with a printout does, and
 * dispatches **every** Fulfilment on it. That is one here — a poster in a parcel — and it is
 * written as a walk rather than as `fulfilments[0]` because an Order has as many as it has ways
 * of being delivered (ADR-0014), and the day this journey buys a download too, the Merchant's job
 * is still to send both.
 */
async function theMerchantDispatches(
  kobai: TestKobai,
  merchant: TestSession,
  orderId: string,
): Promise<string> {
  const opened = await kobai.request(`/admin/orders/${orderId}`, {
    headers: merchant.headers,
  });
  expect(opened.status, "the Merchant opening the Order").toBe(200);
  const order = (await opened.json()) as { fulfilments: readonly { id: string }[] };
  expect(order.fulfilments.length, "an Order with nothing to dispatch").toBeGreaterThan(
    0,
  );

  for (const fulfilment of order.fulfilments) {
    const dispatched = await kobai.request(
      `/admin/orders/${orderId}/fulfilments/${fulfilment.id}/dispatch`,
      {
        method: "POST",
        headers: { ...merchant.headers, "content-type": "application/json" },
        body: JSON.stringify({ trackingReference: THE_TRACKING_REFERENCE }),
      },
    );
    expect(dispatched.status, "the Merchant dispatching it").toBe(200);
  }

  return THE_TRACKING_REFERENCE;
}

/**
 * What the Merchant writes down when they post it — opaque, and kobai reads nothing out of it.
 *
 * A real-looking consignment number, so that the assertion below is about a value travelling
 * unchanged from the Merchant to the Shopper rather than about a format kobai does not have.
 */
const THE_TRACKING_REFERENCE = "RR123456789MY";

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
/** The same size in the other finish — the Variant a half-matched combination would reach. */
const THE_GLOSSY_SKU = "POSTER-A2-GLOSSY";

/** What the Merchant groups the posters under, and the only Collection this Store has. */
const THE_COLLECTION = "Wall art";
/** Copy a Merchant wrote for a Shopper to read — `description`, its own column since #250. */
const THE_DESCRIPTION = "A2 or A3, matte or glossy, printed to order.";

/**
 * The two options this Product is chosen by, and the four values they offer between them.
 *
 * Two rather than one, because with a single option "resolve the combination" and "find the
 * first Variant that mentions the value" are the same code and the journey could not tell them
 * apart. With two, neither value decides on its own.
 */
const THE_SIZE = "Size";
const THE_FINISH = "Finish";

/** What the Shopper picks, and what they would have picked instead. */
const A2 = "A2";
const A3 = "A3";
const MATTE = "Matte";
const GLOSSY = "Glossy";

/**
 * Minor units — 12.50 of whatever the Store prices in, and the amount the first Order below has
 * to come to twice over. It is what a Merchant entered rather than what a Shopper is charged: the
 * redirect Store further down runs the reference Project's own pricing Step, which throws it away
 * (`WHAT_THIS_PROJECT_CHARGES`).
 */
const THE_PRICE = 1250;

/**
 * One value a Variant carries for one option, and the same shape a Shopper picks in.
 *
 * The two really are one thing — a Merchant's `Size` is `A2` and a Shopper's `Size` is `A2` —
 * which is what makes resolving a combination a comparison rather than a translation, and is
 * why `StoreVariantOptionValue` is the shape the page publishes. The Merchant's grid above
 * writes the same values as a record, because that is what the arrangement helper takes; this
 * is the shape they are *published* in, and the journey compares against it.
 */
type APick = {
  readonly name: string;
  readonly value: string;
};

/**
 * The Merchant's grid: every Variant, what it costs, and what it is for each option.
 *
 * **A2 in Glossy and A3 in Matte are why this is a grid rather than a list.** Each shares
 * exactly one value with the combination the Shopper picks below, so a resolution matching one
 * option would have two candidates and could answer either — and A3 in Glossy is deliberately
 * missing, which is a combination being *unavailable* rather than an error (story 21).
 *
 * Only `THE_PRICE` is asserted on below; the other two amounts are simply different, so that a
 * Cart holding the wrong Variant would come to the wrong money.
 *
 * **The options are written the way `seedTestCatalog` takes them** — keyed by the option's name,
 * so the Merchant's half of the fact is said once and the Product declares whatever the grid
 * answers. The first row's key order is the order a storefront offers the options in, which is
 * what the page below is held to.
 */
const THE_GRID: readonly {
  readonly sku: string;
  readonly price: number;
  readonly options: Readonly<Record<string, string>>;
}[] = [
  {
    sku: THE_SKU,
    price: THE_PRICE,
    options: { [THE_SIZE]: A2, [THE_FINISH]: MATTE },
  },
  {
    sku: THE_OTHER_SKU,
    price: 900,
    options: { [THE_SIZE]: A3, [THE_FINISH]: MATTE },
  },
  {
    sku: THE_GLOSSY_SKU,
    price: 1500,
    options: { [THE_SIZE]: A2, [THE_FINISH]: GLOSSY },
  },
];

/**
 * What the Shopper chooses on the page: a value for **every** option the Product declares.
 *
 * A combination answering fewer would be a Shopper who had not finished choosing — so the journey
 * holds this list against the options the *page* reported, names and order both, rather than
 * against the two constants above, which would only be agreeing with itself.
 */
const THE_COMBINATION: readonly APick[] = [
  { name: THE_SIZE, value: A2 },
  { name: THE_FINISH, value: MATTE },
];

/**
 * The two Products a Shopper must never meet, and the addresses a Merchant might have shared.
 *
 * Both are put into `THE_COLLECTION` on purpose. A draft that was in no Collection would be
 * missing from the browse below whatever the store surface did about `status`, so the assertion
 * would pass against a route with no filter at all.
 */
const THE_UNPUBLISHED = [
  { title: "A preview", handle: "a-preview", sku: "PREVIEW", status: "draft" },
  { title: "Last year's", handle: "last-years", sku: "LAST-YEARS", status: "archived" },
] as const;

const BLURB = "Printed on heavy stock.";
const HOW_MANY = 2;
/** What the Store has of it — more than the Shopper takes, so what is held is visible. */
const ON_THE_SHELF = 5;
/** Who the Cart turns out to belong to, once the guest signs in half way through. */
const THE_SHOPPER = "shopper@example.test";

/**
 * What the redirect Store has on its shelf, and what the Shopper takes: all of it.
 *
 * The two are the same number on purpose. A hold covering the whole shelf is what makes the
 * lapsed one refuse a placement rather than merely being an odd row in a table — nothing can be
 * sold past it until the sweeper gives it back.
 */
const THE_LAST_OF_THEM = 2;
/**
 * What that Project charges for one of anything, in **sen**.
 *
 * Not `THE_PRICE`. The reference Project replaced `select-price` with `everything-costs-one-cent`
 * (ADR-0017), so the Merchant's 1250 is not what a Shopper is charged there — which is exactly
 * what the quote has to be asked rather than worked out, and what the payment has to be started
 * for (ADR-0077).
 */
const WHAT_THIS_PROJECT_CHARGES = 1;
/** ISO 4217, and the reason FPX is a path the gate walks rather than prose (ADR-0069). */
const THE_RINGGIT = "MYR";

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

/**
 * One Variant, as far as choosing between them cares — the storefront's half of the pair.
 *
 * Structural rather than the client's own generated type, and the generic below is why: it keeps
 * the *caller's* Variant type, so the Variant this resolves to is still the page's own — carrying
 * its `id`, which the Cart is then filled from. What holds it to the published surface is the
 * call site rather than this declaration: a page whose Variants stopped carrying `options`, or
 * carried them under another name, would no longer satisfy it and `pnpm run typecheck` would
 * say so.
 */
type APickableVariant = {
  readonly sku: string;
  readonly options: readonly APick[];
};

/**
 * The Variant a chosen combination resolves to, worked out **on the page** — the whole point.
 *
 * There is deliberately no route that takes a combination and answers a Variant (#253): the
 * product page already carries the options in the Merchant's order and every Variant's value for
 * each, so a storefront maps one to the other itself and gets the answer without a request. A
 * combination no Variant answers is `undefined` rather than a refusal, which is a size being
 * *unavailable* rather than an error.
 *
 * `every` over the picks rather than `some`, and that is the difference between a combination and
 * a filter: `some` would answer any Variant that merely mentions one of the picked values, which
 * on the grid below is two of them. It is exact rather than merely sufficient because of what
 * sits on both sides of it — the caller answers every option the Product declares, and the routes
 * a Merchant writes a Variant with refuse one answering anything but that same set — so a Variant
 * matching every pick has no further value left to differ by.
 */
function variantAnswering<Variant extends APickableVariant>(
  variants: readonly Variant[],
  combination: readonly APick[],
): Variant | undefined {
  return variants.find((one) =>
    combination.every((pick) =>
      one.options.some((held) => held.name === pick.name && held.value === pick.value),
    ),
  );
}

/** The Shopper's combination with one value changed — what clicking one swatch does. */
function insteadPicking(name: string, value: string): readonly APick[] {
  return THE_COMBINATION.map((pick) => (pick.name === name ? { name, value } : pick));
}

/** Every value one option offers, drawn out of the Variants — what a picker is drawn from. */
function valuesOffered(
  variants: readonly APickableVariant[],
  name: string,
): readonly string[] {
  return [
    ...new Set(
      variants.flatMap((one) =>
        one.options.filter((held) => held.name === name).map((held) => held.value),
      ),
    ),
  ];
}

describe("a Shopper buys something", () => {
  it("browses a Collection, picks an option, builds a Cart and places an Order", async () => {
    await using kobai = await createTestKobai();
    const { browser, server, merchant } = await aStoreWithSomethingToSell(kobai);

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

    // **Where a storefront's navigation comes from.** Nothing on the store surface enumerates
    // Collections, deliberately (#256) — so the link to one is built out of the Collections the
    // Products already on the page report, and this is the identifier that link carries.
    const wallArt = listed?.collections.find((one) => one.title === THE_COLLECTION);
    expect(wallArt, `${THE_PRODUCT} is in no ${THE_COLLECTION}`).toBeDefined();

    // **Browsing the Collection** — this spec's clause, and a Shopper who holds nothing but that
    // identifier. The Collection has three Products in it and a Shopper may see one: the mug is
    // in no Collection at all, and the draft and the archived Product are in *this* one, which
    // is what makes their absence the store surface's own filter rather than an arrangement
    // that never grouped them (#252). A Shopper offered something they cannot buy is the whole
    // failure that filter exists to prevent.
    const browsed = answered(
      await browser.GET("/store/products", {
        params: { query: { collection: wallArt?.id ?? "" } },
      }),
      "browsing the Collection",
    );
    expect(browsed.products).toEqual([listed]);

    // Nor by their address, which is the other half of invisible: a Merchant who shared a
    // preview link shared a `product-not-found` — the refusal an unknown handle gets, rather
    // than one that would confirm the handle is taken.
    for (const { handle } of THE_UNPUBLISHED) {
      const { error } = await browser.GET("/store/products/{idOrHandle}", {
        params: { path: { idOrHandle: handle } },
      });
      expect(error && "reason" in error ? error.reason : undefined, handle).toBe(
        "product-not-found",
      );
    }

    // The product page: one request, and everything on it — **fetched by the handle the
    // Collection reported**, which is story 23 and the whole reason a Product has one. A
    // storefront's own route is `/products/blue-poster`, so the identifier it holds at this
    // point is the address in its URL rather than a UUID it would have had to carry separately.
    const inTheCollection = browsed.products.find((one) => one.title === THE_PRODUCT);
    const page = answered(
      await browser.GET("/store/products/{idOrHandle}", {
        params: { path: { idOrHandle: inTheCollection?.handle ?? "" } },
      }),
      "opening the product page",
    );
    expect(page.title).toBe(THE_PRODUCT);
    // What the Merchant wrote for a Shopper to read, in its own column since catalog breadth…
    expect(page.description).toBe(THE_DESCRIPTION);
    // …and the bag a Project attaches its own copy through, which is ADR-0004's escape hatch
    // and is still the only place anything kobai has no column for can live.
    expect(page.metadata).toEqual({ blurb: BLURB });
    // And the Collection again, from the detail as well as from the list — a product page draws
    // breadcrumbs, and it would be a second request if this did not travel with the Product.
    expect(page.collections).toEqual(listed?.collections);

    // **Picking.** The Shopper answers every option the page declared and nothing it did not, in
    // the order the Merchant put them in, which is the order a picker should offer them — a
    // combination naming fewer would be somebody who had not finished choosing. Asked of the
    // page rather than of the two constants, which would only be the file agreeing with itself.
    expect(THE_COMBINATION.map((pick) => pick.name)).toEqual(
      page.options.map((one) => one.name),
    );
    // What they picked is on the page, and it was a choice. Both values are drawn out of the
    // Variants — there is no route that lists an option's values and there does not need to be —
    // so a value the Merchant renamed stops being offered here, and an option with one value
    // would make the pick a formality rather than a pick.
    for (const pick of THE_COMBINATION) {
      const offered = valuesOffered(page.variants, pick.name);
      expect(offered, `nothing offers a ${pick.name} of ${pick.value}`).toContain(
        pick.value,
      );
      expect(offered.length, `${pick.name} is not a choice`).toBeGreaterThan(1);
    }

    // The SKU, resolved from the payload alone. This is the composition the whole clause is
    // about: a Shopper who arrived holding a Collection's identifier now holds a Variant's.
    const chosen = variantAnswering(page.variants, THE_COMBINATION);
    expect(chosen?.sku, `no Variant is ${A2} in ${MATTE}`).toBe(THE_SKU);

    // **And the combination is what decided it, not half of it.** The Store sells this size in
    // the other finish and the other size in this finish, so a resolution that matched on one
    // value would have had two candidates and could have answered either. Changing one value at
    // a time reaches each of them by name, which is why they are on the shelf.
    expect(variantAnswering(page.variants, insteadPicking(THE_FINISH, GLOSSY))?.sku).toBe(
      THE_GLOSSY_SKU,
    );
    const otherSize = variantAnswering(page.variants, insteadPicking(THE_SIZE, A3));
    expect(otherSize?.sku).toBe(THE_OTHER_SKU);
    // A combination the Merchant never made is **absent rather than an error** (story 21): the
    // page has everything, so it can say "unavailable" without asking kobai anything.
    expect(
      variantAnswering(page.variants, [
        { name: THE_SIZE, value: A3 },
        { name: THE_FINISH, value: GLOSSY },
      ]),
    ).toBeUndefined();

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
    // operations a straight-line purchase never touches. The other size — the one the picker
    // reached above — goes in…
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

    // What the Cart comes to, which is the figure a storefront has to start a payment for
    // (ADR-0077). A redirect payment is created *before* the Shopper leaves and kobai works out
    // the total at Capture, so without this route the amount on the payment is the storefront's
    // own arithmetic — and an expensive Cart bought with a cheap payment is money that never
    // arrived. On the **browser's** key, because a quote claims nothing and moves nothing: it is
    // on the other side of ADR-0055's line from holding and placing.
    const cartQuote = answered(
      await browser.POST("/store/carts/{id}/quote", {
        params: { path: { id: started.id } },
      }),
      "asking what the Cart comes to",
    );
    expect(cartQuote.total).toBe(THE_PRICE * HOW_MANY);
    expect(cartQuote.lineItems.map((one) => one.sku)).toEqual([THE_SKU]);
    // A moment rather than an offer: it says when it was worked out and carries nothing that
    // could be sent back at kobai.
    expect(new Date(cartQuote.quotedAt).getTime()).toBeLessThanOrEqual(Date.now());

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
    // **The figure the storefront was quoted is the figure the Shopper was charged**, which is
    // the whole reason the quote route exists: the payment it started is for the money kobai
    // then took (ADR-0077).
    expect(placed.total).toBe(cartQuote.total);
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
    // Nothing has moved it yet, said before the Merchant acts — otherwise the assertion below
    // would hold just as well of a build where every Fulfilment was born `dispatched`.
    expect(confirmation.fulfilments.map((one) => one.state)).toEqual(["pending"]);

    // The Merchant posts the parcel. Arrangement, above the marker, because a Shopper has no
    // route that dispatches anything — this is the one clause of ADR-0069's sentence that is
    // somebody else's act, and the Shopper's half of it is the read below.
    const tracked = await theMerchantDispatches(kobai, merchant, placed.id);

    // **And the Shopper reads it back dispatched** — over `/store`, through the generated
    // client, with the same key that placed it. That is the last Shopper-facing clause of the
    // sentence this file exists to walk, and it is why `GET /store/orders/{id}` carries each
    // Fulfilment's state at all: a mixed Order would show each part separately here, so a
    // downloaded file is not waiting on a posted one.
    const onItsWay = answered(
      await server.GET("/store/orders/{id}", { params: { path: { id: placed.id } } }),
      "reading the Order back once the Merchant has sent it",
    );
    expect(onItsWay.fulfilments.map((one) => one.state)).toEqual(["dispatched"]);
    // The reference the Merchant wrote down, arriving at the Shopper exactly as it was written:
    // kobai stores it and parses nothing out of it, and models no carrier at all.
    expect(onItsWay.fulfilments[0]?.trackingReference).toBe(tracked);
    // And the Order around it did not move, which is ADR-0014's whole claim: a part of it has a
    // lifecycle and the financial record does not (ADR-0009).
    expect(onItsWay.total).toBe(confirmation.total);
    expect(onItsWay.number).toBe(confirmation.number);
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

/**
 * The same purchase, paid for at a bank — ADR-0070's clause of the sentence.
 *
 * A redirect method takes the money **there**, when the Shopper authorises, which is what makes
 * this a different journey rather than a different payment provider. Three things follow, and
 * each is one of the cases below: the stock has to be held before the Shopper leaves; no Order
 * may exist until the bank has answered; and the answer arrives twice, from the Shopper's
 * browser and from the bank itself, in whichever order the world supplies.
 *
 * The two cases nobody could stage against a real provider are the point of the fake bank.
 * Stripe's sandbox will not abandon a payment on command and will not let a quarter of an hour
 * go by on request, so a gate built on it would walk the happy path and describe the other two
 * in prose.
 *
 * **Two of the four were watched failing before they were trusted**, because an assertion nobody
 * has seen fail is not yet known to be able to:
 *
 * - The race, against a build whose `Idempotency-Key` was a fresh UUID per call rather than the
 *   reference's. It went red on the **books** rather than on the Order count, which is the part
 *   worth recording: both callers ran the Workflow, both charged the same payment, and the one
 *   the unique index on `core_order.cart_id` turned back refunded it — so the Shopper's money
 *   came and went while "exactly one Order" stayed true. That is what the derived key buys, and
 *   a count of Orders could not have told you.
 * - The lapsed hold, twice — once against a route that did not call `refundUnplacedPayment`
 *   (green everywhere except the books, which said the money was still at the bank), and once
 *   with the wind-back taken out, which answered `placed` and proved the arrangement really is
 *   what reaches the refusal rather than something else about the Cart.
 */
describe("a Shopper pays at their bank", () => {
  /**
   * Everything up to the moment the Shopper is inside their banking app: found, held, quoted,
   * and a payment started for what this deployment says the Cart comes to.
   *
   * All four cases share it and none of them may skip it — a Shopper sent to a bank without a
   * hold is the failure ADR-0070 exists to close, and a payment started for a figure kobai did
   * not work out is ADR-0077's.
   */
  async function upToTheBank(store: ARedirectStore) {
    const catalog = answered(
      await store.browser.GET("/store/products"),
      "browsing the catalog",
    );
    const listed = catalog.products.find((one) => one.title === THE_PRODUCT);
    // By identifier here, where the leg above opens the same route by handle: both are the
    // storefront's to use, and the two spellings being one route is what `{idOrHandle}` says.
    const page = answered(
      await store.browser.GET("/store/products/{idOrHandle}", {
        params: { path: { idOrHandle: listed?.id ?? "" } },
      }),
      "opening the product page",
    );
    const variantId = page.variants.find((one) => one.sku === THE_SKU)?.id ?? "";

    const started = answered(
      await store.browser.POST("/store/carts", {}),
      "starting a Cart",
    );
    answered(
      await store.browser.POST("/store/carts/{id}/line-items", {
        params: { path: { id: started.id } },
        body: { variantId, quantity: THE_LAST_OF_THEM },
      }),
      "filling the Cart",
    );

    // What it comes to, on the page's own key — a quote claims nothing and moves nothing, so it
    // is on the other side of ADR-0055's line from the two calls that follow it.
    const quote = answered(
      await store.browser.POST("/store/carts/{id}/quote", {
        params: { path: { id: started.id } },
      }),
      "asking what the Cart comes to",
    );
    expect(quote.currency).toBe(THE_RINGGIT);
    expect(quote.total).toBe(THE_LAST_OF_THEM * WHAT_THIS_PROJECT_CHARGES);

    // The stock, held before the Shopper goes anywhere. A secret key: a page's key that could
    // hold stock could exhaust a Store's (ADR-0055).
    const held = answered(
      await store.server.POST("/store/carts/{id}/reservations", {
        params: { path: { id: started.id } },
      }),
      "holding the stock",
    );
    expect(held.reservations).toEqual([
      { provider: "inventory", subject: variantId, quantity: THE_LAST_OF_THEM },
    ]);

    // And the payment, started by the Developer's own server for the figure kobai quoted. The
    // storefront never names an amount: one that could would be one whose bug the Merchant's
    // books pay for.
    const redirected = await postedAt(store.project, REDIRECT_START_PATH, {
      cartId: started.id,
    });
    expect(redirected.status, "starting the payment").toBe(200);
    expect(redirected.body.amount).toBe(quote.total);
    expect(redirected.body.currency).toBe(THE_RINGGIT);

    return {
      cartId: started.id,
      reference: String(redirected.body.reference),
      total: quote.total,
    };
  }

  it("holds the stock, sends the Shopper to their bank, and has the Order once they are back", async () => {
    const store = await aStoreThatTakesBankRedirects();
    await using _kobai = store.kobai;
    const { reference, total } = await upToTheBank(store);

    // The Shopper authorises, and the money leaves — at the bank, before kobai has heard
    // anything. That is the whole difference from a card, and the reason everything above had
    // to happen first.
    store.bank.authorise(reference);

    // They come back to the tab, and the storefront's return page tells this Project which
    // payment it is. The reference travels on the body and never the query string (#138).
    const settled = await postedAt(store.project, REDIRECT_RETURN_PATH, { reference });

    expect(settled.status).toBe(200);
    expect(settled.body.settled).toBe("placed");
    // And the Order is real, read back over `/store` on the server's key like any other.
    const confirmation = answered(
      await store.server.GET("/store/orders/{id}", {
        params: { path: { id: String(settled.body.orderId) } },
      }),
      "reading the Order back",
    );
    expect(confirmation.total).toBe(total);
    expect(confirmation.currency).toBe(THE_RINGGIT);
    // **The money is the bank's and it has arrived**, which is what a redirect method means:
    // `charge` confirmed a payment that had already been made rather than making one.
    expect(confirmation.payment).toMatchObject({
      provider: "fake-bank",
      reference,
      amount: total,
      received: true,
    });
    // The bank's own books agree, and nothing has been given back.
    expect(store.bank.payment(reference)).toMatchObject({
      status: "authorised",
      refunded: 0,
    });
  });

  it("has the Order anyway when the Shopper never comes back to the tab", async () => {
    // The **ordinary** case, not the exotic one: a Shopper authorises in their banking app and
    // never sees the tab again. Nothing below is a return — that call is simply never made —
    // and the purchase still has to complete, because paying is what buys the thing.
    const store = await aStoreThatTakesBankRedirects();
    await using _kobai = store.kobai;
    const { cartId, reference, total } = await upToTheBank(store);

    store.bank.authorise(reference);

    // The bank tells the Developer's server what happened. Same Project route, same
    // `POST /store/orders` underneath, same `Idempotency-Key` derived from the same reference —
    // which is what makes this and the return one intention rather than two designs.
    const settled = await postedAt(
      store.project,
      REDIRECT_CALLBACK_PATH,
      store.bank.callbackFor(reference),
    );

    expect(settled.status).toBe(200);
    expect(settled.body.settled).toBe("placed");
    const confirmation = answered(
      await store.server.GET("/store/orders/{id}", {
        params: { path: { id: String(settled.body.orderId) } },
      }),
      "reading the Order back",
    );
    expect(confirmation.total).toBe(total);
    expect(confirmation.payment).toMatchObject({ reference, received: true });
    // The Cart became that Order and can become no other, which is what a Shopper who reopens
    // the tab an hour later depends on.
    const abandoned = answered(
      await store.server.GET("/store/carts/{id}", { params: { path: { id: cartId } } }),
      "re-reading the Cart",
    );
    expect(abandoned.placed).toBe(true);
  });

  it("makes exactly one Order of the return and the callback, whichever wins", async () => {
    const store = await aStoreThatTakesBankRedirects();
    await using _kobai = store.kobai;
    const { cartId, reference, total } = await upToTheBank(store);

    store.bank.authorise(reference);

    // Dispatched together, because that is how they arrive: the bank posts its event at the
    // moment the Shopper's browser lands back on the tab, and neither knows about the other.
    // Either may be the one that places.
    const [returned, called] = await Promise.all([
      postedAt(store.project, REDIRECT_RETURN_PATH, { reference }),
      postedAt(store.project, REDIRECT_CALLBACK_PATH, store.bank.callbackFor(reference)),
    ]);

    // One of two answers each, and no third: the Order, or "the other one is placing it". A
    // second Order, a second charge, or a refusal that left the Shopper with neither would each
    // be a different shape from this.
    const orders = new Set(
      [returned, called]
        .map((answer) => answer.body.orderId)
        .filter((id): id is string => typeof id === "string"),
    );
    expect(orders.size, JSON.stringify([returned.body, called.body])).toBe(1);
    for (const answer of [returned, called]) {
      expect(["placed", "elsewhere"]).toContain(answer.body.settled);
    }

    const [orderId] = [...orders];
    const confirmation = answered(
      await store.server.GET("/store/orders/{id}", {
        params: { path: { id: orderId ?? "" } },
      }),
      "reading the Order back",
    );
    expect(confirmation.total).toBe(total);
    // And the Cart is spent, so no third caller could make a second Order of it either.
    const spent = answered(
      await store.server.GET("/store/carts/{id}", { params: { path: { id: cartId } } }),
      "re-reading the Cart",
    );
    expect(spent.placed).toBe(true);
    // One payment, taken once and not given back — the assertion a count of callbacks could
    // never make.
    expect(store.bank.payment(reference)).toMatchObject({
      status: "authorised",
      refunded: 0,
    });
  });

  it("gives the money back when the hold lapsed while the Shopper was at their bank", async () => {
    // **The case to watch hardest**, because it is the only one left in this design that can
    // take a Shopper's money and give them nothing. The hold ran out while they were choosing
    // their bank; the payment went through anyway, because a real-time debit does not ask kobai
    // first; and kobai has nothing left to sell them.
    const store = await aStoreThatTakesBankRedirects();
    await using _kobai = store.kobai;
    const { cartId, reference, total } = await upToTheBank(store);

    await theHoldLapses(store.kobai);
    store.bank.authorise(reference);

    const settled = await postedAt(store.project, REDIRECT_RETURN_PATH, { reference });

    // Refused for the reason that is true, and no Order was written.
    expect(settled.status).toBe(409);
    expect(settled.body.reason).toBe("insufficient-inventory");
    expect(settled.body.orderId).toBeUndefined();
    const unplaced = answered(
      await store.server.GET("/store/carts/{id}", { params: { path: { id: cartId } } }),
      "re-reading the Cart",
    );
    expect(unplaced.placed).toBe(false);

    // **And the Shopper has their money.** Asserted on the bank's books rather than on the
    // refund having been called: "the code ran" and "the Shopper got their money back" are two
    // facts, and the second one is the one a Merchant is asked about.
    expect(store.bank.payment(reference)).toMatchObject({
      status: "refunded",
      refunded: total,
      refusal: "insufficient-inventory",
    });
  });
});
