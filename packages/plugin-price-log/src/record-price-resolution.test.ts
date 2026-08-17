import { defineStep, type ResolvedPrice, StepFailure } from "@kobai/core";
import {
  createTestKobai,
  seedTestCatalog,
  type TestKobai,
  type TestKobaiOptions,
} from "@kobai/core/testing";
import { describe, expect, it } from "vitest";
import { priceLogMigrationSet } from "./migration-set.ts";
import { recordPriceResolution } from "./record-price-resolution.ts";

/**
 * The Step this Plugin **offers** — and what it takes to make it run.
 *
 * ADR-0017's whole claim is here: importing this module installs nothing, and a Project's
 * `kobai.config.ts` is the only thing that puts the Step into a Workflow. So these boot the
 * application both ways and ask the database what happened, rather than watching a callback:
 * a row in `price_log_entry`, or no row, is the only evidence that counts.
 */

/** Every deployment below wires this Plugin's tables; only some wire its Step. */
const WIRED_TABLES: TestKobaiOptions = { migrationSets: [priceLogMigrationSet] };

/** Tables and Step both — the line a Project writes in `kobai.config.ts`. */
const WIRED_STEP: TestKobaiOptions = {
  ...WIRED_TABLES,
  workflows: {
    "resolve-price": { after: { "select-price": [recordPriceResolution] } },
  },
};

/** A Step that refuses after the recording Step has already written its row. */
const closedForStocktake = defineStep(
  "closed-for-stocktake",
  (_resolved: ResolvedPrice): ResolvedPrice => {
    throw new StepFailure("closed-for-stocktake", "This Store is not quoting today.");
  },
);

type LoggedRow = {
  readonly variant_id: string;
  readonly amount: number;
  readonly currency: string;
};

const logged = (kobai: TestKobai) =>
  kobai.database.query<LoggedRow>(
    "select variant_id, amount, currency from price_log_entry",
  );

describe("a Plugin that offers a Step", () => {
  it("records what was resolved, once a Project has wired it", async () => {
    await using kobai = await createTestKobai(WIRED_STEP);
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const response = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    expect(response.status).toBe(200);
    // The Plugin's own table, holding Core's Variant by ID and the amount and currency that
    // were served. Nothing in Core knows this table exists.
    await expect(logged(kobai)).resolves.toEqual([
      { variant_id: catalog.variantId, amount: 1250, currency: "USD" },
    ]);
  });

  it("records one row per resolution", async () => {
    await using kobai = await createTestKobai(WIRED_STEP);
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });
    await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    await expect(logged(kobai)).resolves.toHaveLength(2);
  });

  it("changes the price no more than watching it would", async () => {
    // An inserted Step cannot alter the output contract, and this one does not alter the
    // answer either: the Merchant's Price is what a storefront is told.
    await using kobai = await createTestKobai(WIRED_STEP);
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const response = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    await expect(response.json()).resolves.toMatchObject({
      price: { amount: 1250, currency: "USD" },
      workflow: {
        steps: [
          { step: "load-prices" },
          { step: "select-price" },
          { step: "record-price-resolution", implementation: "record-price-resolution" },
        ],
      },
    });
  });

  it("never runs while it is offered and unwired", async () => {
    // This module imports the Step. It is installed, in scope, and one line of config away
    // from running — and it does not run, because no Project asked for it (ADR-0017).
    await using kobai = await createTestKobai(WIRED_TABLES);
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const response = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    expect(response.status).toBe(200);
    await expect(logged(kobai)).resolves.toEqual([]);
    await expect(response.json()).resolves.toMatchObject({
      workflow: { steps: [{ step: "load-prices" }, { step: "select-price" }] },
    });
  });
});

describe("a Workflow that fails after the Step has written its row", () => {
  const withALaterFailure: TestKobaiOptions = {
    ...WIRED_TABLES,
    workflows: {
      "resolve-price": {
        // Declaration order is run order, and the reverse of unwind order: the recording
        // happens, then the refusal, then the recording is undone.
        after: { "select-price": [recordPriceResolution, closedForStocktake] },
      },
    },
  };

  it("leaves no row behind", async () => {
    await using kobai = await createTestKobai(withALaterFailure);
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const response = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    expect(response.status).toBe(422);
    // Not "the compensation was called" — the row is gone. A Workflow that failed leaves the
    // Store as it found it, and the Plugin's own table is where that is visible.
    await expect(logged(kobai)).resolves.toEqual([]);
  });

  it("takes back both rows when a Project wired the Step twice", async () => {
    // Nothing stops a Project doing this, so the Step's own bookkeeping has to survive it:
    // two writes against one resolved Price, two compensations, and no row orphaned by the
    // second write having overwritten the first's account of itself.
    await using kobai = await createTestKobai({
      ...WIRED_TABLES,
      workflows: {
        "resolve-price": {
          after: {
            "select-price": [
              recordPriceResolution,
              recordPriceResolution,
              closedForStocktake,
            ],
          },
        },
      },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    await expect(logged(kobai)).resolves.toEqual([]);
  });

  it("leaves the rows of the resolutions that succeeded", async () => {
    // Compensation undoes what *this* run did and nothing else. A failure now is not a
    // reason to lose the record of a resolution that was served an hour ago.
    await using kobai = await createTestKobai(withALaterFailure);
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    await kobai.database.query(
      "insert into price_log_entry (variant_id, amount, currency) values ($1, $2, $3)",
      [catalog.variantId, 900, "USD"],
    );
    await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    await expect(logged(kobai)).resolves.toEqual([
      { variant_id: catalog.variantId, amount: 900, currency: "USD" },
    ]);
  });
});
