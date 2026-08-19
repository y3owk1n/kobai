import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { AdjustedLines, PaidOrder } from "../order/place-order.ts";
import type { LoadedPrices, ResolvedPrice } from "../pricing/resolve-price.ts";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  type TestKobai,
} from "../testing/index.ts";
import { defineStep, StepFailure } from "../workflow/step.ts";
import { OPENAPI_DOCUMENT_PATH } from "./openapi.ts";

/**
 * That every `reason` kobai answers with is one the route said it could answer with.
 *
 * ADR-0060 puts the reason strings under the semver promise, and the compiler holds most of
 * them to it for free: a handler's `c.json({ error, reason }, status)` is typed against the
 * schema its route declared, so a reason outside the enum does not build.
 *
 * **Two bodies are written where no route can type them**, and they are what this file is for.
 * `invalidRequestHook` answers `invalid` and `app.onError` answers `malformed-body`, both at
 * 400, and neither passes through `app.openapi` — so a closed enum that forgot one described a
 * surface narrower than the one being served, and did for as long as `CartRefusal` existed.
 * The sweep asks the description which operations take a body and holds every one of them to
 * its own declaration, so the next route added inherits the check rather than the omission.
 */

/** A body that is not JSON at all — what `app.onError` answers `malformed-body` for. */
const UNPARSEABLE = "{not json";

/** A body that parses and fits no schema on this surface — what the hook answers `invalid` for. */
const ILL_FITTING = "[]";

/** The one Variant everything below addresses, named so nothing is asked for by position. */
const SKU = "POSTER-A2";

type Operation = {
  readonly method: string;
  readonly path: string;
  /** The `reason`s this operation's 400 says it can carry, or undefined if it declares none. */
  readonly declared: readonly string[] | undefined;
};

describe("a refusal carries a reason its route declared", () => {
  it("answers every route that takes a body inside its own declared set", async () => {
    const operations = await operationsTakingABody();
    // A `0` here would be a sweep that swept nothing. How many there are is the
    // description's business, not this test's (ADR-0049).
    expect(operations.length).toBeGreaterThan(0);

    await using kobai = await createTestKobai();
    const address = await addressable(kobai);

    // Gathered rather than asserted one at a time, so a failure names every route that is
    // wrong instead of the first one — the list is the diagnosis.
    const undeclared: string[] = [];
    for (const operation of operations) {
      const path = address.fill(operation.path);
      for (const body of [UNPARSEABLE, ILL_FITTING]) {
        const response = await kobai.request(path, {
          method: operation.method.toUpperCase(),
          headers: { ...address.headersFor(path), "content-type": "application/json" },
          body,
        });
        const answered = (await response.json()) as { reason?: unknown };

        const where = `${operation.method.toUpperCase()} ${operation.path} answered ${response.status} ${String(answered.reason)}`;
        if (response.status !== 400) undeclared.push(`${where}, expected 400`);
        else if (operation.declared === undefined)
          undeclared.push(`${where}, and its 400 declares no closed set of reasons`);
        else if (!operation.declared.includes(String(answered.reason)))
          undeclared.push(
            `${where}, which is not one of ${operation.declared.join(", ")}`,
          );
      }
    }

    expect(undeclared).toEqual([]);
  });
});

/**
 * Every operation the description says takes a request body, with the reasons its 400 declares.
 *
 * Read from the checked-in description rather than from a list here: `openapi.test.ts` already
 * proves that file is what this build produces, so asking it is asking the routes.
 */
async function operationsTakingABody(): Promise<Operation[]> {
  const document = await describedSurface();

  const operations: Operation[] = [];
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const declaration = operation as {
        requestBody?: unknown;
        responses?: Record<string, unknown>;
      };
      if (declaration.requestBody === undefined) continue;
      operations.push({
        method,
        path,
        declared: declaredReasons(
          declaration.responses?.["400"],
          document.components.schemas,
        ),
      });
    }
  }
  return operations;
}

/** The `reason` enum a declared response resolves to, following the one `$ref` it may carry. */
function declaredReasons(
  response: unknown,
  schemas: Record<string, unknown>,
): readonly string[] | undefined {
  const schema = (
    response as { content?: { "application/json"?: { schema?: unknown } } } | undefined
  )?.content?.["application/json"]?.schema;
  if (schema === undefined) return undefined;

  const resolved = resolve(schema, schemas) as
    | { properties?: { reason?: { enum?: readonly string[] } } }
    | undefined;
  return resolved?.properties?.reason?.enum;
}

type DescribedSurface = {
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components: {
    readonly schemas: Record<
      string,
      { properties?: { reason?: { type?: string; enum?: unknown; const?: unknown } } }
    >;
  };
};

/**
 * The checked-in description, cast once.
 *
 * One reader rather than one per question, so what a description looks like is asserted in a
 * single place. `openapi.test.ts` already proves this file is what this build produces, so
 * reading it is reading the routes.
 */
async function describedSurface(): Promise<DescribedSurface> {
  return JSON.parse(await readFile(OPENAPI_DOCUMENT_PATH, "utf8")) as DescribedSurface;
}

function resolve(schema: unknown, schemas: Record<string, unknown>): unknown {
  const ref = (schema as { $ref?: string }).$ref;
  if (ref === undefined) return schema;
  return schemas[ref.replace("#/components/schemas/", "")];
}

/**
 * Real identifiers and real credentials for both surfaces, so a swept request is refused for
 * the reason the sweep is about rather than for a bad address or a missing key.
 */
async function addressable(kobai: TestKobai) {
  const catalog = await seedTestCatalog(kobai, {
    variants: [{ sku: SKU, prices: [1250] }],
  });
  const cart = await seedTestCart(kobai, { catalog, lines: [{ sku: SKU }] });

  // By SKU rather than by position, as AGENTS.md requires — a Product reports its Variants in
  // SKU order, not in the order they were asked for. The one Price of the one Variant is
  // indexed because a Variant's Prices are a list with no name to ask by, and this
  // arrangement deliberately puts exactly one there.
  const variant = catalog.variant(SKU);
  const price = variant.prices[0];
  if (price === undefined) throw new Error(`${SKU} was seeded without a Price.`);

  return {
    fill(path: string): string {
      // Three families address three different things through the one parameter name `{id}`:
      // a Cart on the store surface, a Product on the routes under `/admin/products`, and a
      // Variant everywhere else. A swept request is meant to be refused for its body, so it
      // must not be refused for pointing at the wrong kind of row.
      const id = path.startsWith("/store/carts")
        ? cart.id
        : path.startsWith("/admin/products")
          ? catalog.productId
          : variant.id;
      return path
        .replaceAll("{id}", id)
        .replaceAll("{priceId}", price.id)
        .replaceAll("{lineItemId}", cart.lineItem(SKU).id);
    },
    headersFor(path: string): Record<string, string> {
      if (path.startsWith("/store")) return { ...cart.apiKey.headers };
      return { ...catalog.merchant.headers };
    },
  };
}

/**
 * The other half of ADR-0060's line, and the half narrowing Core's own reasons must not cross:
 * a Step this build of Core has never heard of may still refuse, and its own word for why
 * reaches the caller unchanged.
 *
 * Asserted on **both** Workflows a Project can put a Step into, and asserted twice over: that
 * the word travels, and that the description still leaves those `reason`s an open string —
 * because a narrowing that reached them would make the first assertion a lie the moment a
 * client believed the second.
 *
 * There are **three** open families rather than two since ADR-0077, and the third is the same
 * two Workflows arriving at a second route: `POST /store/carts/{id}/quote` runs the pricing half
 * of `place-order`, so a Step a Project supplied refuses a quote in its own words exactly as it
 * refuses a placement. The list below is named rather than counted for that reason — a fourth is
 * a decision somebody has to take on purpose.
 */
describe("a Step Core has never heard of may still refuse", () => {
  it("carries a resolve-price Step's own reason out at 422", async () => {
    await using kobai = await createTestKobai({
      workflows: {
        "resolve-price": {
          steps: {
            "select-price": defineStep(
              "closed-on-sundays",
              (_input: LoadedPrices): ResolvedPrice => {
                throw new StepFailure(
                  "closed-on-sundays",
                  "This Store does not quote prices on a Sunday.",
                );
              },
            ),
          },
        },
      },
    });
    const catalog = await seedTestCatalog(kobai);

    const response = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ reason: "closed-on-sundays" });
  });

  it("carries a place-order Step's own reason out at 422", async () => {
    await using kobai = await createTestKobai({
      workflows: {
        "place-order": {
          before: {
            "capture-order": [
              defineStep("no-orders-today", (_paid: PaidOrder): PaidOrder => {
                throw new StepFailure(
                  "not-today",
                  "This Store is not taking Orders today.",
                );
              }),
            ],
          },
        },
      },
    });
    const cart = await seedTestCart(kobai);

    const response = await kobai.request("/store/orders", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ cartId: cart.id }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ reason: "not-today" });
  });

  it("carries a place-order pricing Step's own reason out of a quote at 422", async () => {
    // The same Step, on the route that runs the pricing half of the same declaration — so the
    // openness is a property of the Workflow rather than of one route that happens to run it.
    await using kobai = await createTestKobai({
      workflows: {
        "place-order": {
          before: {
            "calculate-tax": [
              defineStep("no-quotes-today", (_lines: AdjustedLines): AdjustedLines => {
                throw new StepFailure(
                  "not-today",
                  "This Store is not quoting anything today.",
                );
              }),
            ],
          },
        },
      },
    });
    const cart = await seedTestCart(kobai);

    const response = await kobai.request(`/store/carts/${cart.id}/quote`, {
      method: "POST",
      headers: cart.apiKey.headers,
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ reason: "not-today" });
  });

  it("leaves those three reasons an open string in the description", async () => {
    // Every other refusal schema on the surface is a closed set (ADR-0060). These three are the
    // exception, and the exception is Extension Point 2 — so it is named rather than counted.
    await expect(openReasonSchemas()).resolves.toEqual([
      "PlaceOrderRefusal",
      "PriceRefusal",
      "QuoteRefusal",
    ]);
  });
});

/** The schemas whose `reason` the description leaves an open string, sorted by name. */
async function openReasonSchemas(): Promise<string[]> {
  const document = await describedSurface();
  return Object.entries(document.components.schemas)
    .filter(([, schema]) => {
      const reason = schema.properties?.reason;
      // A closed set is a `string` too — 3.1 renders an enum and a literal as a `type`
      // beside an `enum` or a `const`. Open means neither is there.
      return (
        reason?.type === "string" &&
        reason.enum === undefined &&
        reason.const === undefined
      );
    })
    .map(([name]) => name)
    .sort();
}
