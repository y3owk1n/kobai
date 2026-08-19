import { describe, expect, it } from "vitest";
import { createTestKobai, signInTestMerchant } from "../testing/index.ts";

/**
 * Two Merchants correcting one Product's options at the same instant (#253).
 *
 * **`PATCH /admin/products/{id}` takes `options` as what the list should now *be***, so
 * correcting it is a read of the options a Product has and a write of the options it should
 * have. That is the shape ADR-0018 exists to rule out, arriving through a set of rows rather
 * than through a count: two corrections landing together each read the old list, and each
 * writes the list it wanted over a list the other had already replaced. The visible damage is
 * two options with the same name on one Product — the very state `db/schema.ts` declines to put
 * a unique index behind, because a rename swap is a cycle a per-statement constraint refuses
 * halfway through.
 *
 * **The guard is `lockProductOptions`, a `pg_advisory_xact_lock` per Product**, taken before the
 * read. A **row** lock cannot do it: `lockProduct` is `for share`, and two `FOR SHARE` holders do
 * not conflict in Postgres at all — that lock keeps a `DELETE` out, which is existence, and
 * serialises nothing against another correction. The row lock is still taken beside it, still
 * only for that.
 *
 * **No sequential assertion can see any of this** — every case in `options.test.ts` passes
 * against a build with the advisory lock deleted — so this test dispatches at once, in the shape
 * `the-cart-that-held-twice.test.ts` set. Three things about how it is written carry to the next
 * one:
 *
 * - **Every correction asks for the same two options**, and the second of them is *new* each
 *   time: an entry with no `id` is an option this Product does not have. Serialised, each
 *   correction reads what the one before it left and its own list is what the Product ends with,
 *   so the answer is two options however many requests there were. Unserialised, all of them
 *   read one option and all of them insert a `Colour`.
 * - **The assertion is on the Store rather than on the responses.** Each response reports the
 *   list its own transaction saw, and under the failure being guarded against every one of them
 *   is a perfectly plausible two-option list — it is the row count afterwards that is wrong. The
 *   responses are checked for having succeeded, because a correction that 500ed would leave the
 *   same tidy final state for entirely the wrong reason.
 * - **It was watched failing**, with the `lockProductOptions` line commented out: eight
 *   corrections, eight rows named `Colour`, and the final list nine options long. Changing how
 *   these requests are dispatched obliges you to watch it fail again — once the fix is in, a
 *   request that landed in the window and one that arrived after the other transaction committed
 *   answer identically, so a green run cannot tell a contended race from an arrangement that
 *   quietly stopped overlapping.
 */

/**
 * How many corrections go at once.
 *
 * Big enough that more than one is inside the read-then-write window on any scheduling, and
 * small enough to stay well inside the connection pool — queueing behind connections would
 * serialise the very thing this test exists to overlap, and it would do it invisibly.
 */
const AT_ONCE = 8;

describe("two corrections of one option list", () => {
  it("leaves the Product with the options the last of them asked for, and no duplicate", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const headers = { ...merchant.headers, "content-type": "application/json" };

    const created = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "A poster",
        options: [{ name: "Size" }],
        variants: [{ sku: "POSTER-A2", options: [{ name: "Size", value: "A2" }] }],
      }),
    });
    expect(created.status, "the arrangement could not create a Product").toBe(201);
    const product = (await created.json()) as {
      readonly id: string;
      readonly options: readonly { readonly id: string; readonly name: string }[];
    };
    const size = product.options[0];
    expect(size?.name).toBe("Size");

    const answers = await Promise.all(
      Array.from({ length: AT_ONCE }, () =>
        kobai.request(`/admin/products/${product.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            // The Size this Product already has, kept by its identifier, and a Colour it does
            // not have — so every one of these is an insert, and they are all the same insert.
            options: [{ id: size?.id, name: "Size" }, { name: "Colour" }],
          }),
        }),
      ),
    );

    // Not the subject, and worth asserting anyway: a correction that fell over would leave the
    // tidy final state below for the wrong reason entirely.
    expect(answers.map((one) => one.status)).toEqual(Array(AT_ONCE).fill(200));

    const read = await kobai.request(`/admin/products/${product.id}`, {
      headers: merchant.headers,
    });
    expect(read.status).toBe(200);
    const after = (await read.json()) as {
      readonly options: readonly { readonly name: string }[];
    };

    // The whole assertion: the last correction to run is what the Product is, and each of the
    // ones before it read what its predecessor left rather than the list they all started from.
    expect(after.options.map((one) => one.name)).toEqual(["Size", "Colour"]);
  });
});
