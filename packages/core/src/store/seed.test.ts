import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestKobai, signInTestMerchant, type TestKobai } from "../testing/index.ts";

/**
 * The default Region a boot seeds (#291, ADR-0041, ADR-0074).
 *
 * **A boot rather than a migration**, which is the decision `store/seed.ts` argues: a Region
 * *selects* the Store's currency, and a Project's own migration set may move that currency after
 * Core's set has run — the reference Project's does exactly that. So the seed asks the question
 * at the one moment every set has applied.
 *
 * Three promises, and the third is the one nothing sequential can see:
 *
 * - a deployment that has never seeded one gets a Region named from what it prices in;
 * - booting twice creates no second one;
 * - **two processes booting at once create no second one either**, which is a lock rather than a
 *   check and so is asserted by dispatching both at the same instant.
 *
 * And a fourth that is about a failure rather than a success: **seeding never stops a boot**. It
 * reports, and a caller decides — ADR-0041's rule, and its reason is that a process that exited
 * over this would be indistinguishable, to whatever supervises the container, from the failed
 * migration that must exit.
 */

/**
 * How many processes boot at once in the case below.
 *
 * Big enough that more than one is inside the window on any scheduling, and small enough to stay
 * well inside the connection pool — queueing behind connections serialises the very thing the
 * case exists to overlap, which is the failure the warm-up in it is about.
 */
const BOOTS = 4;

/** What the Store reports about itself, as much of it as this file reads. */
async function storeOf(
  kobai: TestKobai,
  headers: Record<string, string>,
): Promise<{
  readonly defaultCurrency: string;
  readonly currencies: readonly { readonly code: string }[];
  readonly defaultRegion: {
    readonly id: string;
    readonly name: string;
    readonly currency: string;
  } | null;
}> {
  const response = await kobai.request("/admin/store", { headers });
  return (await response.json()) as never;
}

describe("seeding the default Region", () => {
  it("names it from the currency this Store prices in, and points the Store at it", async () => {
    // **`defaultRegion: false` is what makes this file's subject reachable at all**, and every
    // case in it takes it: since #292 the harness seeds this Region as a boot does, because a
    // deployment that has booted has one and every price route falls back to it. This is the
    // pre-boot state, which no request could otherwise produce.
    await using kobai = await createTestKobai({ defaultRegion: false });

    const seeded = await kobai.seedDefaultRegion();

    expect(seeded).toEqual({
      status: "seeded",
      region: {
        id: expect.any(String),
        // The code itself, because that is the only honest thing a deployment which has said
        // nothing about geography can be called. A Merchant renames it.
        name: "USD",
        currency: "USD",
      },
    });

    const merchant = await signInTestMerchant(kobai);
    const store = await storeOf(kobai, merchant.headers);
    expect(store.defaultRegion).toEqual({
      id: expect.any(String),
      name: "USD",
      currency: "USD",
      metadata: {},
    });
    // It is a Region like any other: the list is where a Merchant meets it.
    await expect(
      (await kobai.request("/admin/regions", { headers: merchant.headers })).json(),
    ).resolves.toMatchObject({ regions: [{ name: "USD", currency: "USD" }] });
  });

  it("creates no second one on the next boot, and leaves a renamed one alone", async () => {
    await using kobai = await createTestKobai({ defaultRegion: false });
    await kobai.seedDefaultRegion();
    const merchant = await signInTestMerchant(kobai);
    const before = await storeOf(kobai, merchant.headers);
    await kobai.request(`/admin/regions/${before.defaultRegion?.id}`, {
      method: "PATCH",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "United States" }),
    });

    const again = await kobai.seedDefaultRegion();

    // The ordinary second boot, and the thing it must not do is quietly undo a Merchant's own
    // edit — which is ADR-0041's "left exactly as it was found" one noun along.
    expect(again).toEqual({ status: "already-present" });
    const after = await storeOf(kobai, merchant.headers);
    expect(after.defaultRegion?.id).toBe(before.defaultRegion?.id);
    expect(after.defaultRegion?.name).toBe("United States");
    await expect(
      (await kobai.request("/admin/regions", { headers: merchant.headers })).json(),
    ).resolves.toMatchObject({ regions: [{ name: "United States" }] });
  });

  it("creates no second one when two processes boot against one database at once", async () => {
    await using kobai = await createTestKobai({ defaultRegion: false });
    // **The pool is warmed first, and that line is the whole reason this test can fail at all.**
    // `pg.Pool` opens a connection lazily, so three seeds dispatched at once against a cold pool
    // are not three concurrent transactions: the first is served by the connection that is
    // already open and has committed before the other two have finished a TCP handshake. Every
    // one of them then reads a Store that already has its Region, and a build with no lock in it
    // passes — which is ADR-0049's trap arriving as a green run. **Watched both ways**: against
    // `seedDefaultRegion` with its advisory lock deleted, this case is green without these round
    // trips in front of it and red with them, reporting four `seeded` outcomes where one is
    // true. Changing how the seeds are dispatched obliges the next person to watch it fail
    // again, because once the lock is in nothing green can tell a contended run from a
    // serialised one.
    await Promise.all(
      Array.from({ length: BOOTS }, () => kobai.db.execute(sql`select 1`)),
    );

    // All at the same instant, because this is the case the check outside the transaction
    // cannot decide: each looks, each finds no default Region, and one has to win. Nothing
    // sequential can tell a correct implementation from one that would create three here —
    // which is the same reason `the-last-unit.test.ts` dispatches rather than iterates.
    const outcomes = await Promise.all(
      Array.from({ length: BOOTS }, () => kobai.seedDefaultRegion()),
    );

    expect(outcomes.filter((one) => one.status === "seeded")).toHaveLength(1);
    expect(outcomes.filter((one) => one.status === "already-present")).toHaveLength(
      BOOTS - 1,
    );
    const merchant = await signInTestMerchant(kobai);
    const listed = (await (
      await kobai.request("/admin/regions", { headers: merchant.headers })
    ).json()) as { regions: readonly unknown[] };
    expect(listed.regions).toHaveLength(1);
  });

  it("reports rather than throws when there is nothing to derive one from", async () => {
    await using kobai = await createTestKobai({ defaultRegion: false });
    // A migrated database holding no Store — what a hand-run `DELETE` leaves, and the one state
    // in which there is no currency to name a Region from. It answers rather than rejecting,
    // because **nothing about seeding stops a boot**: a deployment with no default Region is a
    // working deployment whose storefront has to name one, and a process that died over it
    // would look, to whatever supervises the container, exactly like the failed migration that
    // must die (ADR-0041).
    await kobai.database.query("delete from core_store");

    await expect(kobai.seedDefaultRegion()).resolves.toMatchObject({
      status: "not-usable",
    });
  });
});
