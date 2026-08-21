import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  type CoreWorkflowOverrides,
  defineStep,
  type LoadedPrices,
  type ResolvedPrice,
} from "@kobai/core";
import {
  createTestKobai,
  inspectSchema,
  seedTestCart,
  seedTestCatalog,
  seedTestOrder,
  signInTestMerchant,
  type TestKobai,
  type TestOrder,
} from "@kobai/core/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import config, { bank, confirmations, dispatches } from "../kobai.config.ts";

/**
 * The reference Project's side of ADR-0017: a Plugin offers, and the Project wires.
 *
 * `packages/plugin-price-log` proves that a Plugin *can* own a table. This proves that a
 * Project is what decides whether it does — and it does so through the same
 * `kobai.config.ts` a Developer would edit, booted through the same `createKobai` the
 * entrypoint calls.
 */
describe("installing the Plugins", () => {
  it("is an ordinary npm dependency and nothing more", async () => {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { dependencies?: Record<string, string> };

    // No installer, no registry of its own, no postinstall step: a Plugin arrives the way
    // every other package does, and the only other thing kobai asks of a Developer is the
    // one line in `kobai.config.ts` below. Three of them now, and none of the later two cost
    // the mechanism anything — which is the claim more than one Plugin is here to check.
    expect(manifest.dependencies?.["@kobai/plugin-price-log"]).toBeDefined();
    expect(manifest.dependencies?.["@kobai/plugin-made-to-order"]).toBeDefined();
    expect(manifest.dependencies?.["@kobai/plugin-stripe"]).toBeDefined();
  });
});

describe("the reference Project's configuration", () => {
  it("wires each Plugin's migration set beside its own, and that is the whole of the wiring", () => {
    // Four sets, and the grouping is the point. Three arrived as dependencies and do nothing
    // until this file names them (ADR-0017); `project` is this Project's own, covering tables
    // neither Core nor any Plugin has heard of. They are the same kind of object applied by
    // the same runner, which is what makes "a Project owns tables on the same terms a Plugin
    // does" a fact about the code rather than a claim in a document.
    //
    // `plugin-stripe` is the one whose set is wired whether or not its provider is — which is
    // the same ADR-0017 point from the other side: naming a migration set installs a Plugin's
    // *tables* and commits a deployment to nothing else. Here it is wired and the provider is
    // not, because the gate is a deployment nobody has given Stripe.
    //
    // **This is the one enumeration of the set list #129 deliberately left standing**, and
    // it is where a Plugin's line is meant to be read: this is the Project's test of its own
    // `kobai.config.ts`, so the list *is* the subject rather than an expectation borrowed to
    // check something else. Everywhere else in the repository the list is derived — see
    // `tests/support/wired-migration-sets.ts` and docs/agents/writing-tests.md.
    expect(config.migrationSets?.map((set) => set.name)).toEqual([
      "plugin-price-log",
      "plugin-made-to-order",
      "plugin-stripe",
      "project",
    ]);
  });

  it("brings its own table into being, in its own tracking table", async () => {
    await using kobai = await createTestKobai(config);
    const schema = inspectSchema(kobai.database);

    // The Project's table exists...
    await expect(schema.tablesOwnedBy("project")).resolves.toEqual([
      "project_variant_note",
    ]);

    // ...and it is tracked separately from Core's and from each Plugin's, so none of the five
    // can race or re-apply another's work.
    const tracking = (await schema.migrationTracking()).map((fact) => fact.table);
    expect(tracking).toContain("__drizzle_migrations_project");
    expect(tracking).toContain("__drizzle_migrations_core");
    expect(tracking).toContain("__drizzle_migrations_plugin_price_log");
    expect(tracking).toContain("__drizzle_migrations_plugin_made_to_order");
    expect(tracking).toContain("__drizzle_migrations_plugin_stripe");
  });

  it("puts no foreign key from its own tables into Core's", async () => {
    // A Project *may* add one, unlike a Plugin — it owns its repository and its schema. This
    // one deliberately does not, because the constraint would tie its migrations to Core's
    // table still being called what it is called today, which is the coupling that turns an
    // upgrade back into a merge (ADR-0001).
    await using kobai = await createTestKobai(config);

    await expect(
      inspectSchema(kobai.database).foreignKeysCrossingInto("core"),
    ).resolves.toEqual([]);
  });

  it("brings the Plugin's table into being when Core boots with it", async () => {
    await using kobai = await createTestKobai(config);

    await expect(
      inspectSchema(kobai.database).tablesOwnedBy("price_log"),
    ).resolves.toEqual(["price_log_entry"]);
  });

  it("leaves it absent when the same Project boots without it", async () => {
    // The same Project, the same installed dependency, one line of config removed. This is
    // the difference wiring makes, and it is the only difference.
    await using kobai = await createTestKobai({ ...config, migrationSets: [] });

    await expect(
      inspectSchema(kobai.database).tablesOwnedBy("price_log"),
    ).resolves.toEqual([]);
  });

  it("still serves the Store, and this one prices in ringgit", async () => {
    await using kobai = await createTestKobai(config);
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/store", { headers: merchant.headers });

    expect(response.status).toBe(200);
    // A wired Plugin changes no Core behaviour, which is what this read was originally for.
    // **`MYR` is this Project's own doing** — Core seeds the placeholder `USD` and no route
    // will move it (ADR-0065), so `migrations/0001_the_store_prices_in_myr.sql` is what says
    // this deployment prices in ringgit, and it is why a redirect payment here can be FPX at
    // all: which methods a provider offers is decided by the currency (ADR-0069, ADR-0070).
    await expect(response.json()).resolves.toEqual({
      name: "kobai",
      defaultCurrency: "MYR",
      // **Ringgit and nothing else**, which is `migrations/0002_the_store_enables_myr.sql`'s
      // whole subject: Core's set enables whatever the Store held when it ran, and on a fresh
      // database that is Core's own `USD` placeholder, because Core's set applies in front of
      // this Project's. Without that second migration this Store would enable a currency it
      // does not sell in and not the one it does.
      currencies: [{ code: "MYR" }],
      // Seeded at boot by `kobai.seedDefaultRegion()`, which `src/server.ts` calls and the
      // harness has called for itself since #292 — and **named `MYR` rather than `USD` is this
      // Project's second migration showing through**: a Region selects one of the enabled
      // currencies, and the seed runs after every migration set, so it names what this
      // deployment actually prices in rather than Core's placeholder.
      defaultRegion: {
        id: expect.any(String),
        name: "MYR",
        currency: "MYR",
        // This Project prices no delivery, and that is a Merchant's decision rather than a
        // Project's: a boot has nothing to say what carriage costs from (#321).
        shippingMethods: [],
        metadata: {},
      },
      metadata: {},
    });
  });
});

/**
 * The claim the whole project rests on, demonstrated once.
 *
 * A Developer opens `kobai.config.ts`, replaces one Step of Core's price-resolution Workflow
 * with their own, and the API answers differently. No fork, no copied service, no patched
 * dependency: `@kobai/core` is the same version in this Project's `package.json` as it was
 * before, and nothing in it knows this override exists.
 *
 * The price it serves is wrong on purpose. An override you have to squint at proves nothing —
 * so a Merchant sets $12.50 and a storefront is told one cent.
 */
describe("the Step this Project replaced", () => {
  it("is wired against Core as an ordinary versioned dependency", async () => {
    // The other half of "no fork": the override above changed this Project and nothing
    // upstream, so `@kobai/core` is a dependency like any other, at whatever version this
    // Project pinned. There is no patch, no `file:` path to a modified copy, and no
    // `resolutions` entry — the three shapes that would mean the customisation had reached
    // into Core after all (ADR-0001).
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as Record<string, unknown> & { dependencies?: Record<string, string> };

    expect(manifest.dependencies?.["@kobai/core"]).toBeDefined();
    expect(manifest.dependencies?.["@kobai/core"]).not.toMatch(/^(file|link):/);
    for (const wayOut of ["resolutions", "overrides", "pnpm", "patchedDependencies"]) {
      expect(manifest[wayOut], wayOut).toBeUndefined();
    }
  });

  it("serves one cent for a Variant a Merchant priced at $12.50", async () => {
    await using kobai = await createTestKobai(config);
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const response = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      variant: { sku: "POSTER-A2" },
      // Not 1250. The Price row still says 1250 — the rule that reads it is this Project's.
      price: { amount: 1, currency: "MYR" },
    });
  });

  it("shows in the response that it ran in place of Core's Step", async () => {
    // `step` is the slot Core declared and `implementation` is what filled it. A Developer
    // reads this and knows their Step ran, rather than taking it on trust (spec story 33).
    await using kobai = await createTestKobai(config);
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const response = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    await expect(response.json()).resolves.toMatchObject({
      workflow: {
        name: "resolve-price",
        steps: [
          { step: "load-prices", implementation: "load-prices" },
          { step: "select-price", implementation: "everything-costs-one-cent" },
          // The Plugin's Step, in a position of its own rather than in one of Core's slots:
          // it fills no slot, so it answers to its own name on both sides.
          { step: "record-price-resolution", implementation: "record-price-resolution" },
        ],
      },
    });
  });

  it("is the whole of the difference — take the line out and the Price row wins again", async () => {
    // The same Project, the same Core, the same dependency version. One entry in one file is
    // what stands between $12.50 and a penny, which is what "customisation lives in a Project"
    // has to mean to be worth anything (ADR-0001).
    await using kobai = await createTestKobai({ ...config, workflows: {} });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const response = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    await expect(response.json()).resolves.toMatchObject({
      price: { amount: 1250, currency: "MYR" },
      workflow: {
        steps: [
          { step: "load-prices", implementation: "load-prices" },
          { step: "select-price", implementation: "select-price" },
        ],
      },
    });
  });

  it("leaves a Variant with no Price refused, because the replacement is a real Step", async () => {
    await using kobai = await createTestKobai(config);
    const catalog = await seedTestCatalog(kobai, {
      // A priced Variant and an unpriced one, because what this test is about is the
      // replacement refusing for the second while it serves the first.
      variants: [{ prices: [1250] }, { prices: [] }],
    });

    const response = await kobai.request(
      `/store/variants/${catalog.variant("POSTER-A3").id}/price`,
      {
        headers: catalog.apiKey.headers,
      },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      reason: "price-not-set",
      workflow: { failed: "select-price" },
    });
  });
});

/**
 * The Step this Project did not write, and chose to run anyway.
 *
 * `@kobai/plugin-price-log` offers `recordPriceResolution`; nothing about installing the
 * Plugin runs it. The one line in `kobai.config.ts` is what does — beside the replacement
 * rather than inside it, because watching a Step and owning one are different things
 * (ADR-0017).
 */
describe("the Step this Project wired from a Plugin", () => {
  it("records each resolution to the Plugin's own table", async () => {
    await using kobai = await createTestKobai(config);
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    // One cent, because this Project also replaced the rule — the Plugin records what was
    // *served*, which is the point of watching the Workflow rather than the database.
    await expect(
      kobai.database.query("select variant_id, amount, currency from price_log_entry"),
    ).resolves.toEqual([{ variant_id: catalog.variantId, amount: 1, currency: "MYR" }]);
  });

  it("records nothing when the same Project boots without that line", async () => {
    // The same Project, the same installed Plugin, the same wired tables. One entry removed
    // from one file, and the Step that was offered stays offered.
    await using kobai = await createTestKobai({
      ...config,
      workflows: {
        "resolve-price": { steps: config.workflows?.["resolve-price"]?.steps },
      },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const response = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    expect(response.status).toBe(200);
    await expect(kobai.database.query("select id from price_log_entry")).resolves.toEqual(
      [],
    );
  });
});

/**
 * The interface this Project implements because kobai does not.
 *
 * A replaced Step changes a decision Core would have made; this fills a hole Core deliberately
 * left (ADR-0053). It is the first implementation of a named kobai interface to come from outside
 * kobai, which is the standard #72 sets for dependency substitution being proven rather than
 * merely present — so both halves are asserted here: that wiring it is what lets this deployment
 * take an Order, and that removing the line leaves everything else working.
 *
 * **Which provider this Project supplies is a question about its environment** (ADR-0070). Given
 * Stripe's three settings it is `@kobai/plugin-stripe`'s and this Store takes payments at a
 * bank; given none it is `src/payments/manual.ts` and this Store settles out of band. Every
 * test below is the second, because the gate is a deployment nobody has given Stripe and
 * `vitest.config.ts` blanks those variables to keep it one whatever a Developer's shell
 * exports — the gate has no Stripe secret and must never acquire one.
 */
describe("what this deployment takes money with", () => {
  it("settles out of band, because nobody has given this one Stripe", () => {
    // The two halves of the same line in `kobai.config.ts`, pinned together: no Stripe
    // configuration means no bank, and no bank means `manual`. It is also what makes every
    // assertion below — and the upgrade gate's, which boots this Project for real — about a
    // provider that moves no money and calls nothing.
    expect(bank).toBeNull();
    expect(config.payments?.provider?.name).toBe("manual");
  });

  it("takes payments at a bank when this deployment has been given Stripe's settings", async () => {
    // The same file, the same Project, read with an environment that has been filled in —
    // which is the whole of what wiring `@kobai/plugin-stripe` costs a Developer: a dependency
    // and some settings, with no line of this repository edited (ADR-0069's bar).
    //
    // Re-imported rather than reconfigured, because this config is read once at boot from
    // `process.env`, and what is under test is *that* reading. Nothing here reaches Stripe: a
    // provider is built and asked its name, which is a property of the object.
    //
    // Undone whatever happens below, and that is not tidiness: a failed assertion that left
    // these set would hand a Stripe configuration to every test after it in this file, which
    // is the one thing the gate must never have.
    onTestFinished(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test_123");
    vi.stubEnv("STRIPE_PAYMENT_PAGE_URL", "https://storefront.test/checkout/pay");
    vi.resetModules();

    const configured = (await import(
      "../kobai.config.ts"
    )) as typeof import("../kobai.config.ts");

    expect(configured.bank?.provider.name).toBe("stripe");
    expect(configured.default.payments?.provider?.name).toBe("stripe");
    expect(configured.bank?.configuration.paymentPageUrl).toBe(
      "https://storefront.test/checkout/pay",
    );
  });
});

describe("the Payment Provider this Project supplies", () => {
  /** A Cart with something in it, placed — the shortest path to the money. */
  async function placeAnOrder(kobai: TestKobai) {
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog });

    return kobai.request("/store/orders", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ cartId: cart.id }),
    });
  }

  it("takes the payment, and the Order records that it was this Project's", async () => {
    await using kobai = await createTestKobai(config);

    const response = await placeAnOrder(kobai);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      // One cent, because this Project also replaced the pricing rule — the two customisations
      // meet here, and the Payment is for what was actually charged.
      total: 1,
      payment: {
        provider: "manual",
        amount: 1,
        currency: "MYR",
        reference: expect.stringMatching(/^manual-/),
      },
    });
  });

  it("refuses to place an Order when the same Project boots without that line", async () => {
    // The same Project, the same Core, one entry removed from one file. Everything else still
    // serves — this is a Store that cannot be bought from rather than a Store that is down.
    await using kobai = await createTestKobai({ ...config, payments: {} });

    const response = await placeAnOrder(kobai);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      reason: "no-payment-provider",
    });
  });

  it("still serves the catalog with no provider wired, because only money is missing", async () => {
    await using kobai = await createTestKobai({ ...config, payments: {} });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const response = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    expect(response.status).toBe(200);
  });
});

/**
 * The Plugin this Project wired in all three ways a Plugin can be wired.
 *
 * `@kobai/plugin-made-to-order` offers a migration set, a Fulfilment Strategy and a Step, and
 * this Project names all three. It is the deepest use of the extension surface in this
 * repository — dependency substitution from *outside* Core (ADR-0052), a replaced Step in
 * `place-order`, and an input Core has never modelled reaching that Step through the open
 * Workflow context (ADR-0013) — so this is where it is checked that all of it survives being
 * assembled by a Project rather than by a test.
 */
describe("the Plugin this Project makes its commissions with", () => {
  /** Something this Store makes rather than stocks. Nobody counts it; nobody has to. */
  async function aCommission(kobai: TestKobai) {
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "COMMISSION", fulfilmentStrategy: "made-to-order" }],
    });
    return { catalog, cart: await seedTestCart(kobai, { catalog }) };
  }

  it("sells a Variant that is made rather than stocked, and charges for the hurry", async () => {
    await using kobai = await createTestKobai(config);
    const { cart } = await aCommission(kobai);

    // The lead time travels in the query string, which is one of the two halves the open
    // context is filled from (#121) and the one a Lead Time belongs in — it is not a
    // credential. It is a key Core has never heard of either way, which is the point.
    const response = await kobai.request("/store/orders?leadTimeDays=3", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ cartId: cart.id }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      // A penny for the goods, because this Project also replaced the pricing rule, and 3500
      // for seven days saved. Both customisations are on this one Order, and neither knows
      // about the other.
      total: 3501,
      lineItems: [
        {
          sku: "COMMISSION",
          unitAmount: 1,
          adjustments: [{ code: "lead-time-surcharge", amount: 3500 }],
        },
      ],
      // What the Plugin's Strategy answered, snapshotted by Core because it asked rather than
      // because it knows what made-to-order is.
      fulfilments: [
        { strategy: "made-to-order", tracksInventory: false, hasLeadTime: true },
      ],
    });
  });

  it("charges nothing extra when the same Project boots without the Step", async () => {
    // One entry out of one file. The Strategy stays wired, so the commission still sells — it
    // simply costs what it costs (ADR-0017).
    await using kobai = await createTestKobai({
      ...config,
      workflows: { "resolve-price": config.workflows?.["resolve-price"] },
    });
    const { cart } = await aCommission(kobai);

    const response = await kobai.request("/store/orders?leadTimeDays=3", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ cartId: cart.id }),
    });

    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      lineItems: [{ adjustments: [] }],
    });
  });

  it("has no such Variant to sell when the same Project boots without the Strategy", async () => {
    // The other line, taken out on its own: a Variant may point only at a Strategy this
    // deployment has wired, so this Store no longer has anything it makes to order.
    await using kobai = await createTestKobai({ ...config, fulfilment: {} });
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({
        title: "A commission",
        variants: [{ sku: "COMMISSION", fulfilment: { strategy: "made-to-order" } }],
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "unknown-fulfilment-strategy",
    });
  });
});

/**
 * The arrangement the two Subscriber describes below share.
 *
 * It goes through `/admin`, because dispatching is a Merchant's act and there is no store route
 * that moves a Fulfilment.
 */

/** An Order with one Fulfilment, and that Fulfilment as a Merchant reads it back. */
async function anOrderToDispatch(kobai: TestKobai) {
  const order = await seedTestOrder(kobai);
  const read = await kobai.request(`/admin/orders/${order.id}`, {
    headers: order.catalog.merchant.headers,
  });
  expect(read.status).toBe(200);
  const body = (await read.json()) as {
    fulfilments: readonly { id: string; state: string }[];
  };
  const [only] = body.fulfilments;
  if (!only) throw new Error("this Order has no Fulfilment");
  return { order, fulfilmentId: only.id };
}

/** Marks it dispatched, exactly as the Admin does. */
function dispatch(
  kobai: TestKobai,
  order: TestOrder,
  fulfilmentId: string,
  trackingReference?: string,
) {
  return kobai.request(`/admin/orders/${order.id}/fulfilments/${fulfilmentId}/dispatch`, {
    method: "POST",
    headers: {
      ...order.catalog.merchant.headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(trackingReference === undefined ? {} : { trackingReference }),
  });
}

/**
 * **The Subscriber this Project wired** — ADR-0003's fourth Extension Point, proven rather than
 * promised (ADR-0085, #70, #322).
 *
 * kobai emits, and one line of `kobai.config.ts` is what makes anything happen about it. So the
 * pair below is the same pair the Plugin's Step gets: this Project boots with the line and with
 * it removed, and what is asserted either way is **what the Subscriber did with what it was
 * handed** — the notices in this deployment's own outbox, field by field — never that a callback
 * was reached. A counter would say the same thing about a Subscriber told a lie.
 */
describe("the Subscriber this Project wired", () => {
  it("queues the notice this Store owes the Shopper, carrying what kobai said", async () => {
    await using kobai = await createTestKobai(config);
    const { order, fulfilmentId } = await anOrderToDispatch(kobai);

    const response = await dispatch(kobai, order, fulfilmentId, "RR123456789MY");

    expect(response.status).toBe(200);
    // This Project's own record of what it will tell the Shopper — an identifier it can read
    // the Order back by, the reference the Shopper follows the parcel with, and when kobai says
    // it left. `toEqual` on the whole notice, so a field that stopped arriving is a failure.
    expect(confirmations.noticesFor(order.id)).toEqual([
      {
        fulfilmentId,
        orderId: order.id,
        trackingReference: "RR123456789MY",
        occurredAt: expect.any(String),
      },
    ]);
    // And that last field is a reading of the row kobai wrote rather than of a clock this
    // Project consulted, which is the whole reason a payload carries one.
    const [notice] = confirmations.noticesFor(order.id);
    const [row] = await kobai.database.query<{ updated_at: Date }>(
      "select updated_at from core_fulfilment where id = $1",
      [fulfilmentId],
    );
    expect(notice?.occurredAt).toBe(new Date(row?.updated_at ?? 0).toISOString());
  });

  it("queues nothing when the same Project boots without that line", async () => {
    // The same Project, the same imported module, the same object it makes. One entry removed
    // from one file, and nothing subscribes: installing a package subscribes to nothing, and
    // neither does importing one (ADR-0017).
    await using kobai = await createTestKobai({ ...config, events: {} });
    const { order, fulfilmentId } = await anOrderToDispatch(kobai);

    const response = await dispatch(kobai, order, fulfilmentId, "RR123456789MY");

    // The dispatch is untouched — a deployment that wires no Subscriber behaves exactly as one
    // that had never heard of the Extension Point.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "dispatched",
      trackingReference: "RR123456789MY",
    });
    expect(confirmations.noticesFor(order.id)).toEqual([]);
  });
});

/**
 * **The Subscriber this Project did not write, and chose to run anyway** (#323).
 *
 * `@kobai/plugin-price-log` offers `dispatchLog` beside the Step it already offered, and this is
 * the pair above told a second time from the other end: there the Subscriber was this Project's
 * own source, here it arrives in a **package**. Nothing about installing that package subscribes
 * to anything, and nothing about importing it does either — the line in `kobai.config.ts` is the
 * whole of it, which is the claim ADR-0017 exists to make and the one an events surface could
 * most easily have broken.
 *
 * It is deliberately the same shape as the Step's own pair a few describes above: booted with
 * the line, and booted with it taken out. What is asserted either way is **what the Plugin's
 * Subscriber did with what it was handed** — the entries in the log this Project holds, field by
 * field — never that a callback was reached.
 */
describe("the Subscriber this Project wired from a Plugin", () => {
  it("logs the dispatch to the Plugin's own log, carrying what kobai said", async () => {
    await using kobai = await createTestKobai(config);
    const { order, fulfilmentId } = await anOrderToDispatch(kobai);

    const response = await dispatch(kobai, order, fulfilmentId, "RR123456789MY");

    expect(response.status).toBe(200);
    const [row] = await kobai.database.query<{ updated_at: Date }>(
      "select updated_at from core_fulfilment where id = $1",
      [fulfilmentId],
    );
    // The whole entry, held to the same standard as the outbox's notice above — including
    // `occurredAt` being a reading of the row kobai wrote rather than of a clock this process
    // consulted, which is the whole reason a payload carries one.
    expect(dispatches.entriesFor(order.id)).toEqual([
      {
        fulfilmentId,
        orderId: order.id,
        trackingReference: "RR123456789MY",
        occurredAt: new Date(row?.updated_at ?? 0).toISOString(),
      },
    ]);
  });

  it("runs beside this Project's own Subscriber, both told the same thing", async () => {
    // Two Subscribers on one Event, one from a package and one from this Project's own source,
    // and neither has heard of the other. A list is what a Project writes when it wants two
    // things to happen, and the order it writes them in is the order they run in (ADR-0085).
    await using kobai = await createTestKobai(config);
    const { order, fulfilmentId } = await anOrderToDispatch(kobai);

    expect((await dispatch(kobai, order, fulfilmentId, "RR987654321MY")).status).toBe(
      200,
    );

    const [notice] = confirmations.noticesFor(order.id);
    const [entry] = dispatches.entriesFor(order.id);
    expect(notice).toEqual({
      fulfilmentId,
      orderId: order.id,
      trackingReference: "RR987654321MY",
      occurredAt: expect.any(String),
    });
    // The same fact, told twice, and told the same both times — which is what a payload being
    // produced by Core and read by whoever was wired has to mean.
    expect(entry).toEqual(notice);
  });

  it("logs nothing when the same Project boots without that line", async () => {
    // The same Project, the same installed Plugin, the same wired tables. One entry removed
    // from one file, and the Subscriber that was offered stays offered (ADR-0017).
    await using kobai = await createTestKobai({
      ...config,
      events: {
        subscribers: { "fulfilment-dispatched": [confirmations.tellTheShopper] },
      },
    });
    const { order, fulfilmentId } = await anOrderToDispatch(kobai);

    const response = await dispatch(kobai, order, fulfilmentId, "RR123456789MY");

    // This Project's own Subscriber still ran, so what is asserted below is the Plugin's
    // absence rather than a deployment that wired nobody at all.
    expect(response.status).toBe(200);
    expect(confirmations.noticesFor(order.id)).toHaveLength(1);
    expect(dispatches.entriesFor(order.id)).toEqual([]);
  });
});

/**
 * What the compiler refuses to let this Project wire.
 *
 * Checked by `pnpm -r typecheck`, which includes this file — ADR-0017's "a replacement must
 * satisfy the original Step's input and output types" is a promise about the config a
 * Developer writes, so it is asserted against the config's own type rather than against an
 * alias inside Core.
 */
describe("what this Project could not have wired", () => {
  it("rejects a Step that produces something other than a resolved Price", () => {
    const wrong: CoreWorkflowOverrides = {
      "resolve-price": {
        steps: {
          // @ts-expect-error `select-price` gives a ResolvedPrice, and this gives a number.
          "select-price": defineStep("a-bare-number", (_input: LoadedPrices) => 1),
        },
      },
    };

    expect(wrong).toBeDefined();
  });

  it("rejects a Step that demands more than the slot provides", () => {
    const fussy: CoreWorkflowOverrides = {
      "resolve-price": {
        steps: {
          // @ts-expect-error `select-price` is given the loaded Prices and nothing else.
          "select-price": defineStep(
            "wants-a-cart",
            (input: LoadedPrices & { readonly cartTotal: number }): ResolvedPrice => ({
              variant: input.variant,
              region: input.region,
              channel: input.channel,
              price: { id: "x", amount: input.cartTotal, currency: "USD" },
            }),
          ),
        },
      },
    };

    expect(fussy).toBeDefined();
  });

  it("rejects an inserted Step that would change the price it was shown", () => {
    // Insertion is the weaker mechanism and this is the weakness, at the surface a Developer
    // writes it at. A Step in `after` may read what `select-price` decided and must hand back
    // the same shape, so a Project that wants to charge double has to *own* the slot and say
    // so in `steps` — observation cannot quietly become mutation (spec story 29).
    const doubling: CoreWorkflowOverrides = {
      "resolve-price": {
        after: {
          "select-price": [
            // @ts-expect-error a resolved Price in, and this gives back a bare number.
            defineStep(
              "doubles-the-price",
              (resolved: ResolvedPrice) => resolved.price.amount * 2,
            ),
          ],
        },
      },
    };

    expect(doubling).toBeDefined();
  });
});
