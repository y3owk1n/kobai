import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createTestKobai, seedTestCart, type TestKobai } from "../testing/index.ts";
import { OPENAPI_DOCUMENT_PATH } from "./openapi.ts";

/**
 * A correction that changes nothing is refused, and every `PATCH` says so in the same words.
 *
 * ADR-0062 settled one shape for correcting a record, and #185 made it one implementation —
 * `packages/core/src/patch.ts`. This is what keeps it one. The rule had been written out per
 * module and had drifted: two of the six refusals were missing the sentence the other four
 * share, and half the `metadata` refusals named the field in backticks where the rest named it
 * bare. Nothing went red, because a sentence nobody asserts can say anything.
 *
 * **The routes are asked for rather than written down** (ADR-0049). {@link CORRECTIONS} says
 * only how to *reach* each one — a path needs an identifier and a credential, and neither is
 * derivable — and the last case here holds that table against every `patch` operation the
 * checked-in description carries, in both directions. So a `PATCH` added without an entry
 * reddens the build instead of quietly opting out of every sweep in the file, exactly as
 * `pagination.test.ts` holds `LISTS`.
 *
 * **The two sides are deliberately different sides.** The sweeps dispatch at the *running*
 * application; the table is checked against `packages/core/openapi.json`, the checked-in
 * artifact. A derivation that read the side under test would agree with itself, which is the
 * trap ADR-0049 names. {@link CHANGES_NOTHING} is written out below for the same reason rather
 * than imported from `patch.ts`: imported, one edit to that template would move every route and
 * every assertion here together and prove nothing.
 *
 * **Watched failing three ways**, because an assertion nobody has seen fail is not yet known to
 * be able to:
 *
 * - against `origin/main`'s `catalog/update.ts`, whose two refusals carried no shared sentence:
 *   both of the first two cases fail, each naming `/admin/products/{id}`;
 * - against a `changesNothing` whose field list said `fulfilmentStrategy` — the column — where a
 *   caller sends `fulfilment`: one failure, naming the field and the route. That is the drift
 *   the second case exists for, and the one nothing else can see;
 * - with an entry taken out of {@link CORRECTIONS}: the last case, naming the orphaned path.
 *
 * The first of those is also how the `boundary` assertion below came to exist — without it the
 * second case failed naming a *route path* as though it were a field. Re-watch all three if you
 * change how a route is reached here.
 */

/**
 * The sentence every no-op refusal carries, from ADR-0062.
 *
 * Written out rather than imported. It is a promise about what a Merchant reads, so moving it
 * should mean editing this file on purpose — which is exactly what importing it would remove.
 */
const CHANGES_NOTHING =
  "A request that changes nothing is more likely a mistake than an intention.";

/** How to reach one correction: a path with its identifiers filled, and whose credential. */
type Correction = {
  readonly path: string;
  readonly described: string;
  readonly headers: Record<string, string>;
};

/**
 * Every `PATCH` on the surface, as the description spells it.
 *
 * `described` is the templated path the description carries and is what the last case compares;
 * building the real one is {@link everyCorrection}'s job, because an identifier has to be
 * seeded before it can be asked for.
 */
const CORRECTIONS = [
  "/admin/store",
  "/admin/products/{id}",
  "/admin/variants/{id}",
  "/admin/roles/{id}",
  "/admin/merchants/{id}",
  "/store/carts/{id}",
  "/store/carts/{id}/line-items/{lineItemId}",
] as const;

/** As much of the description as this file reads: each `patch`'s request schema. */
type DescribedPaths = {
  readonly paths: Record<
    string,
    {
      readonly patch?: {
        readonly requestBody?: {
          readonly content: Record<
            string,
            { readonly schema: { readonly $ref: string } }
          >;
        };
      };
    }
  >;
  readonly components: {
    readonly schemas: Record<string, { readonly properties?: Record<string, unknown> }>;
  };
};

/**
 * One arrangement for all of them, because none of them is about what it is correcting.
 *
 * `seedTestCart` reaches furthest — it seeds a catalog, which signs a Merchant in and mints a
 * secret key — so a Cart and its line come free with the Product and the Variant. The Role is
 * the one thing nothing seeds, and it goes through `POST /admin/roles` like a Merchant's would
 * (#173), never through an insert. The Merchant this corrects is the seeded one itself: a body
 * naming nothing is refused before anything reads a row, so which Merchant it addresses cannot
 * matter — and it is the one Merchant that exists without a second request.
 */
async function everyCorrection(kobai: TestKobai): Promise<readonly Correction[]> {
  const cart = await seedTestCart(kobai);
  const merchant = cart.catalog.merchant.headers;
  const key = cart.apiKey.headers;

  const created = await kobai.request("/admin/roles", {
    method: "POST",
    headers: { ...merchant, "content-type": "application/json" },
    body: JSON.stringify({ name: "Reads the catalog", permissions: ["product:read"] }),
  });
  expect(created.status, "the arrangement could not create a Role").toBe(201);
  const role = (await created.json()) as { readonly id: string };

  const session = await kobai.request("/admin/session", { headers: merchant });
  expect(session.status, "the arrangement could not read the session").toBe(200);
  const who = (await session.json()) as { readonly merchant: { readonly id: string } };

  return [
    { described: "/admin/store", path: "/admin/store", headers: merchant },
    {
      described: "/admin/products/{id}",
      path: `/admin/products/${cart.catalog.productId}`,
      headers: merchant,
    },
    {
      described: "/admin/variants/{id}",
      path: `/admin/variants/${cart.catalog.variantId}`,
      headers: merchant,
    },
    {
      described: "/admin/roles/{id}",
      path: `/admin/roles/${role.id}`,
      headers: merchant,
    },
    {
      described: "/admin/merchants/{id}",
      path: `/admin/merchants/${who.merchant.id}`,
      headers: merchant,
    },
    { described: "/store/carts/{id}", path: `/store/carts/${cart.id}`, headers: key },
    {
      described: "/store/carts/{id}/line-items/{lineItemId}",
      path: `/store/carts/${cart.id}/line-items/${cart.lineItem("POSTER-A2").id}`,
      headers: key,
    },
  ];
}

/** Sends a body naming nothing, and reads back the refusal it earned. */
async function correctWithNothing(
  kobai: TestKobai,
  correction: Correction,
): Promise<{ readonly status: number; readonly reason: string; readonly error: string }> {
  const response = await kobai.request(correction.path, {
    method: "PATCH",
    headers: { ...correction.headers, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = (await response.json()) as { reason?: string; error?: string };
  return { status: response.status, reason: body.reason ?? "", error: body.error ?? "" };
}

describe("a correction that changes nothing", () => {
  it("is refused at 400, by every PATCH there is, in the same words", async () => {
    await using kobai = await createTestKobai();

    for (const correction of await everyCorrection(kobai)) {
      const refusal = await correctWithNothing(kobai, correction);

      expect(refusal.status, `${correction.described} answered ${refusal.status}`).toBe(
        400,
      );
      expect(refusal.reason, `${correction.described} refused for another reason`).toBe(
        "invalid",
      );
      // The whole point of #185: one sentence, not one per module.
      expect(
        refusal.error,
        `${correction.described} does not carry the shared sentence`,
      ).toContain(CHANGES_NOTHING);
    }
  });

  it("names fields the route actually accepts, and it names some", async () => {
    // The half no type can see. `changesNothing`'s field list is prose, and it names the fields
    // as the **wire** spells them while `changesFrom` is keyed by the column — so
    // `PATCH /admin/variants/{id}` saying `fulfilmentStrategy` would be a refusal telling a
    // Merchant to send a field the schema strips. That is why the list cannot simply be derived
    // from the table, and why it is read back out of the sentence and checked here instead.
    const described = JSON.parse(
      await readFile(OPENAPI_DOCUMENT_PATH, "utf8"),
    ) as DescribedPaths;

    await using kobai = await createTestKobai();

    for (const correction of await everyCorrection(kobai)) {
      const { error } = await correctWithNothing(kobai, correction);

      // Only the clause before the shared sentence: what follows it is the route's second half,
      // which names the *other* routes a stripped field belongs to and so names their fields.
      // The boundary is asserted rather than sliced at blind — `indexOf` answers -1 for a
      // refusal missing the sentence, and `slice(0, -1)` would then read almost the whole
      // refusal and fail naming a *route path* as though it were a field. Watched doing exactly
      // that against `origin/main`, which is how this line came to be here.
      const boundary = error.indexOf(CHANGES_NOTHING);
      expect(
        boundary,
        `${correction.described} does not carry the shared sentence, so there is no field list to read`,
      ).toBeGreaterThan(0);
      const named = [...error.slice(0, boundary).matchAll(/`([^`]+)`/g)].map(
        (match) => match[1],
      );

      expect(
        named.length,
        `${correction.described} names no field at all`,
      ).toBeGreaterThan(0);

      const reference =
        described.paths[correction.described]?.patch?.requestBody?.content[
          "application/json"
        ]?.schema.$ref ?? "";
      const accepted = Object.keys(
        described.components.schemas[reference.split("/").at(-1) ?? ""]?.properties ?? {},
      );
      expect(
        accepted.length,
        `${correction.described} describes no request body, so this case is vacuous`,
      ).toBeGreaterThan(0);

      for (const field of named) {
        expect(
          accepted,
          `${correction.described} tells a Merchant to name \`${field}\`, which its schema does not accept`,
        ).toContain(field);
      }
    }
  });

  it("sweeps every PATCH the description carries, and no path that is gone", async () => {
    const described = JSON.parse(
      await readFile(OPENAPI_DOCUMENT_PATH, "utf8"),
    ) as DescribedPaths;

    const corrections = Object.entries(described.paths)
      .filter(([, operations]) => operations.patch !== undefined)
      .map(([path]) => path)
      .sort();

    expect(
      corrections.length,
      "the description carries no PATCH at all, so every sweep here is vacuous",
    ).toBeGreaterThan(0);
    // Both directions: a correction missing from `CORRECTIONS` is swept by nothing, and one
    // named there that no longer exists would leave every case above passing against a path
    // that is gone.
    expect(corrections).toEqual([...CORRECTIONS].sort());
  });
});
