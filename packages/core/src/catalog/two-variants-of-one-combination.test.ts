import { describe, expect, it } from "vitest";
import { createTestKobai, signInTestMerchant } from "../testing/index.ts";

/**
 * Two Merchants adding one combination to one Product at the same instant (#277).
 *
 * **No two Variants of a Product may answer its options the same way**, because a storefront
 * maps the combination a Shopper chose to a SKU out of the detail payload and there is
 * deliberately no route that would answer it a second way (#253). What makes that rule hard is
 * that the fact is spread over one row per option, so no unique index can hold it: the check is
 * a `select` over the Product's *other* Variants followed by an `insert` of this one, which is
 * the shape ADR-0018 exists to rule out. Two adds landing together each read a Product that
 * does not yet hold the other, and both are allowed through.
 *
 * **The guard is `lockProductOptions`, a `pg_advisory_xact_lock` per Product** — the key
 * `two-corrections-of-one-option-list.test.ts` already made this table serialise on, taken by
 * the same three writes on purpose: a Variant's combination is judged against the option list a
 * correction may be replacing at that instant, so two keys would serialise each kind against
 * itself and neither against the other. A **row** lock cannot do it either: `lockProduct` is
 * `for share`, and two `FOR SHARE` holders do not conflict in Postgres at all.
 *
 * **No sequential assertion can see any of this** — every case in `options.test.ts` passes
 * against a build with the advisory lock deleted — so this test dispatches at once, in the shape
 * `the-last-unit.test.ts` set. Three things about how it is written carry to the next one:
 *
 * - **Every request asks for the same combination and a SKU of its own.** A SKU each, so that
 *   `sku-taken` cannot be what refuses the losers — with one SKU shared this test would pass
 *   just as well against a build with no rule in it at all, refused by the unique index for a
 *   completely different reason.
 * - **The assertion is on the Store as well as on the answers.** One 201 and seven 409s is what
 *   a Merchant is told; that the Product holds one Variant answering `A2`/`Matte` afterwards is
 *   the fact the telling is supposed to be about, and under the failure being guarded against
 *   the responses are a perfectly plausible eight 201s.
 * - **It was watched failing**, with the `lockProductOptions` line taken out of `addVariant`:
 *   eight requests, **three** of them answered 201, and a Product left holding three Variants
 *   that answer one combination — the exact state #253's payload cannot be chosen from. How
 *   many get through is the scheduling's business and not the point; more than one is. Changing
 *   how these requests are dispatched obliges you to watch it fail again: once the fix is in, a
 *   request that landed in the window and one that arrived after the other transaction
 *   committed answer identically, so a green run cannot tell a contended race from an
 *   arrangement that quietly stopped overlapping.
 */

/**
 * How many adds go at once.
 *
 * Big enough that more than one is inside the read-then-write window on any scheduling, and
 * small enough to stay well inside the connection pool — queueing behind connections would
 * serialise the very thing this test exists to overlap, and it would do it invisibly.
 */
const AT_ONCE = 8;

describe("two Variants of one combination", () => {
  it("lets exactly one of them through and refuses the rest", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const headers = { ...merchant.headers, "content-type": "application/json" };

    const created = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "A poster",
        options: [{ name: "Size" }, { name: "Finish" }],
        variants: [
          {
            sku: "POSTER-A3-GLOSSY",
            options: [
              { name: "Size", value: "A3" },
              { name: "Finish", value: "Glossy" },
            ],
          },
        ],
      }),
    });
    expect(created.status, "the arrangement could not create a Product").toBe(201);
    const product = (await created.json()) as { readonly id: string };

    const answers = await Promise.all(
      Array.from({ length: AT_ONCE }, (_, index) =>
        kobai.request(`/admin/products/${product.id}/variants`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            // A SKU of its own, so that what refuses the losers can only be the combination.
            sku: `POSTER-A2-MATTE-${index}`,
            options: [
              { name: "Size", value: "A2" },
              { name: "Finish", value: "Matte" },
            ],
          }),
        }),
      ),
    );

    const statuses = answers.map((one) => one.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    // And the losers were told the thing that is true, rather than failing some other way: a
    // 500 from the unique index, or a 201 each.
    expect(statuses.filter((status) => status === 409)).toHaveLength(AT_ONCE - 1);
    const refused = answers.find((one) => one.status === 409);
    expect(refused, "every one of them was allowed through").toBeDefined();
    const refusal =
      refused === undefined
        ? undefined
        : ((await refused.json()) as { readonly reason?: string });
    expect(refusal?.reason).toBe("variant-combination-taken");

    // The books, which is what the telling was supposed to be about. Asked of the database
    // rather than of the payload, because the payload is what a storefront would then be unable
    // to choose from — and the count is what says why.
    const rows = await kobai.database.query<{ count: string }>(
      `select count(*)::text as count
         from core_variant_option_value value
         join core_product_option option on option.id = value.option_id
        where option.product_id = $1 and option.name = 'Size' and value.value = 'A2'`,
      [product.id],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });
});
