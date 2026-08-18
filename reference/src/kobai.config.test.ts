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
  signInTestMerchant,
  type TestKobai,
} from "@kobai/core/testing";
import { describe, expect, it } from "vitest";
import config from "../kobai.config.ts";

/**
 * The reference Project's side of ADR-0017: a Plugin offers, and the Project wires.
 *
 * `packages/plugin-price-log` proves that a Plugin *can* own a table. This proves that a
 * Project is what decides whether it does — and it does so through the same
 * `kobai.config.ts` a Developer would edit, booted through the same `createKobai` the
 * entrypoint calls.
 */
describe("installing the Plugin", () => {
  it("is an ordinary npm dependency and nothing more", async () => {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { dependencies?: Record<string, string> };

    // No installer, no registry of its own, no postinstall step: a Plugin arrives the way
    // every other package does, and the only other thing kobai asks of a Developer is the
    // one line in `kobai.config.ts` below.
    expect(manifest.dependencies?.["@kobai/plugin-price-log"]).toBeDefined();
  });
});

describe("the reference Project's configuration", () => {
  it("wires the Plugin's migration set beside its own, and that is the whole of the wiring", () => {
    // Two sets, and the pair is the point. `plugin-price-log` arrived as a dependency and
    // does nothing until this file names it (ADR-0017); `project` is this Project's own,
    // covering tables neither Core nor any Plugin has heard of. They are the same kind of
    // object applied by the same runner, which is what makes "a Project owns tables on the
    // same terms a Plugin does" a fact about the code rather than a claim in a document.
    expect(config.migrationSets?.map((set) => set.name)).toEqual([
      "plugin-price-log",
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

    // ...and it is tracked separately from Core's and the Plugin's, so none of the three
    // can race or re-apply another's work.
    const tracking = (await schema.migrationTracking()).map((fact) => fact.table);
    expect(tracking).toContain("__drizzle_migrations_project");
    expect(tracking).toContain("__drizzle_migrations_core");
    expect(tracking).toContain("__drizzle_migrations_plugin_price_log");
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

  it("still serves the Store, because a wired Plugin changes no Core behaviour", async () => {
    await using kobai = await createTestKobai(config);
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/store", { headers: merchant.headers });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      name: "kobai",
      defaultCurrency: "USD",
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
      price: { amount: 1, currency: "USD" },
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
      price: { amount: 1250, currency: "USD" },
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
    ).resolves.toEqual([{ variant_id: catalog.variantId, amount: 1, currency: "USD" }]);
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
 */
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
        currency: "USD",
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
