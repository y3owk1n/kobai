import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  type CoreWorkflowOverrides,
  defineStep,
  type LoadedPrices,
  type ResolvedPrice,
} from "@kobai/core";
import {
  createTestApiKey,
  createTestKobai,
  inspectSchema,
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
  it("wires the Plugin's migration set, and that is the whole of the wiring", () => {
    expect(config.migrationSets?.map((set) => set.name)).toEqual(["plugin-price-log"]);
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
    const store = await priced(kobai, 1250);

    const response = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: store.headers,
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
    const store = await priced(kobai, 1250);

    const response = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: store.headers,
    });

    await expect(response.json()).resolves.toMatchObject({
      workflow: {
        name: "resolve-price",
        steps: [
          { step: "load-prices", implementation: "load-prices" },
          { step: "select-price", implementation: "everything-costs-one-cent" },
        ],
      },
    });
  });

  it("is the whole of the difference — take the line out and the Price row wins again", async () => {
    // The same Project, the same Core, the same dependency version. One entry in one file is
    // what stands between $12.50 and a penny, which is what "customisation lives in a Project"
    // has to mean to be worth anything (ADR-0001).
    await using kobai = await createTestKobai({ ...config, workflows: {} });
    const store = await priced(kobai, 1250);

    const response = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: store.headers,
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
    const store = await priced(kobai, 1250);

    const response = await kobai.request(
      `/store/variants/${store.unpricedVariantId}/price`,
      {
        headers: store.headers,
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
});

type Priced = {
  readonly variantId: string;
  readonly unpricedVariantId: string;
  /** A key's headers, ready to ask the store surface with. */
  readonly headers: Record<string, string>;
};

/**
 * A Store holding one priced Variant and one unpriced one, created through the public API.
 *
 * Through the API rather than by writing rows, because this Project has no more access to
 * Core's tables than any other Project does.
 */
async function priced(instance: TestKobai, amount: number): Promise<Priced> {
  const merchant = await signInTestMerchant(instance);
  const json = { ...merchant.headers, "content-type": "application/json" };

  const product = (await (
    await instance.request("/admin/products", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        title: "A poster",
        variants: [{ sku: "POSTER-A2" }, { sku: "POSTER-A3" }],
      }),
    })
  ).json()) as { variants: { id: string; sku: string }[] };
  const idOf = (sku: string) => product.variants.find((row) => row.sku === sku)?.id ?? "";
  const variantId = idOf("POSTER-A2");

  await instance.request(`/admin/variants/${variantId}/prices`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ amount }),
  });

  const key = await createTestApiKey(instance, merchant, { name: "storefront" });

  return { variantId, unpricedVariantId: idOf("POSTER-A3"), headers: key.headers };
}
