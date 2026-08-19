import { describe, expect, it } from "vitest";
import { createTestKobai, seedTestCatalog, type TestKobai } from "../testing/index.ts";
import { lockProduct, lockVariant, lockVariants } from "./lock.ts";

/**
 * **The lock four writes lean on, watched being taken.**
 *
 * `setPrice`, `addLineItem`, `setInventory` and `capture-order` all ask whether a Variant is
 * there and then write a row referencing it, and all four are correct only because the answer
 * is *held* — see `lock.ts`. What holds it is now one function, which is the point of this
 * refactor and also its risk: a `for share` quietly dropped there would take the guarantee
 * away from all four at once, and every test above it would stay green.
 *
 * **The HTTP seam cannot see it, and that is why this file is not at the HTTP seam.** The
 * races that cover these routes — `the-last-unit.test.ts`, `the-variant-that-vanished.test.ts`
 * — are the right shape for what they assert and each says the same thing about itself: a
 * request that lands in the gap and one that arrives after it are answered identically *by
 * design*, so a green run cannot tell a held lock from a race that stopped overlapping. Only
 * the recorded failing run proves the gap was ever reached. Nor can a request be dispatched
 * against a row this test holds and be found to wait, because inserting a row that references
 * a Variant takes a lock on it whether or not anybody asked for one — a Postgres foreign key
 * does that by itself, so both implementations would block and the assertion would pass for
 * the wrong reason.
 *
 * So this calls the function and asks Postgres, which is where a lock is a fact (ADR-0011),
 * exactly as `updated-at.test.ts` asks it about a trigger. It is a **deliberate exception** to
 * "the dominant seam is the public HTTP API" (docs/agents/writing-tests.md): it couples to one
 * internal name, which is a cost paid once and moved with a rename, in exchange for the only
 * assertion in this repository that can watch this lock fail.
 *
 * **And it was watched failing, the way a contention test has to be.** With the `.for("share")`
 * taken out of `lockVariants` and nothing else changed, both assertions about a delete being
 * kept out went red on the run this file was written against — `expected 'deleted' to be
 * 'waited'`, twice, while the two that only read the answer stayed green. That is the whole
 * proof these four cases can tell a held row from an unheld one; a lock nobody has seen missing
 * is not yet known to be missable.
 *
 * **`lockProduct` is here for the same reason and was watched the same way** (#172). It is the
 * head of the chain `lock.ts` names, and `addVariant` is correct only because the Product it
 * inserts against is held: without the lock a `DELETE /admin/products/{id}` landing between the
 * check and the insert makes a foreign-key violation and a 500 on a route that declares a 404.
 * Taking the `.for("share")` out of `lockProduct` alone turned its delete case red —
 * `expected 'deleted' to be 'waited'` — while every other test in this repository, the new
 * routes' own included, stayed green.
 */

/**
 * How long the delete is willing to wait before reporting that it could not get in.
 *
 * A `lock_timeout` rather than a race: the delete is *expected* to be blocked, so something has
 * to end the wait, and a deadline that expires is a deterministic answer rather than a timing
 * one. Long enough that a loaded machine does not report a lock nobody is holding, short enough
 * that the failing case — no lock at all — is over in a fraction of a second.
 */
const WAITS_FOR = "250ms";

describe("holding a Variant still", () => {
  it("keeps a delete out for the length of the transaction", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    await kobai.db.transaction(async (tx) => {
      await expect(lockVariant(tx, catalog.variantId)).resolves.toBe(true);

      await expect(deletingVariantRow(kobai, catalog.variantId)).resolves.toBe("waited");
    });

    // And the assertion can tell the two apart, which is what makes the line above mean
    // anything: with the transaction closed and nobody holding the row, the very same delete
    // gets in at once.
    await expect(deletingVariantRow(kobai, catalog.variantId)).resolves.toBe("deleted");
  });

  it("answers `false` for a Variant that is not there", async () => {
    await using kobai = await createTestKobai();

    await kobai.db.transaction(async (tx) => {
      await expect(lockVariant(tx, "00000000-0000-4000-8000-000000000000")).resolves.toBe(
        false,
      );
    });
  });

  it("reports which of several Variants are there, and holds those", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "HERE" }, { sku: "GONE" }],
    });
    const here = catalog.variant("HERE").id;
    const gone = catalog.variant("GONE").id;

    // Deleted before anything locks anything, so the plural form meets exactly what a Capture
    // meets: some of the Variants its Cart named, and not all of them.
    await expect(deletingVariantRow(kobai, gone)).resolves.toBe("deleted");

    await kobai.db.transaction(async (tx) => {
      await expect(lockVariants(tx, [here, gone, here])).resolves.toEqual(
        new Set([here]),
      );

      await expect(deletingVariantRow(kobai, here)).resolves.toBe("waited");
    });
  });

  it("asks nothing at all when the list is empty", async () => {
    await using kobai = await createTestKobai();

    // A Cart with no lines reaches `capture-order` like any other, and `in ()` is not a query
    // Postgres will run.
    await kobai.db.transaction(async (tx) => {
      await expect(lockVariants(tx, [])).resolves.toEqual(new Set());
    });
  });
});

describe("holding a Product still", () => {
  it("keeps a delete out for the length of the transaction", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    await kobai.db.transaction(async (tx) => {
      await expect(lockProduct(tx, catalog.productId)).resolves.toBe(true);

      // `addVariant` is the one caller, and it is correct only because the answer above is
      // *held*: it inserts a row referencing this Product, and a `DELETE
      // /admin/products/{id}` landing between the two statements would make that a
      // foreign-key violation and a 500 on a route that declares a 404.
      await expect(deletingProductRow(kobai, catalog.productId)).resolves.toBe("waited");
    });

    // And the assertion can tell the two apart: with nobody holding the row, the very same
    // delete gets in at once.
    await expect(deletingProductRow(kobai, catalog.productId)).resolves.toBe("deleted");
  });

  it("answers `false` for a Product that is not there", async () => {
    await using kobai = await createTestKobai();

    await kobai.db.transaction(async (tx) => {
      await expect(lockProduct(tx, "00000000-0000-4000-8000-000000000000")).resolves.toBe(
        false,
      );
    });
  });
});

/**
 * Deletes the row from a connection of its own, and says whether it got in.
 *
 * `set lock_timeout` and the delete travel as one string on purpose: `TestDatabase.query`
 * connects per call, so the setting and the statement it governs have to be in the same one.
 */
async function deletingVariantRow(
  kobai: TestKobai,
  variantId: string,
): Promise<"deleted" | "waited"> {
  return deletingRow(kobai, "core_variant", variantId);
}

/** The same question one table up, for `lockProduct` — `deleteProduct`'s statement. */
async function deletingProductRow(
  kobai: TestKobai,
  productId: string,
): Promise<"deleted" | "waited"> {
  return deletingRow(kobai, "core_product", productId);
}

async function deletingRow(
  kobai: TestKobai,
  table: "core_product" | "core_variant",
  id: string,
): Promise<"deleted" | "waited"> {
  try {
    await kobai.database.query(
      `set lock_timeout = '${WAITS_FOR}'; delete from ${table} where id = '${id}'`,
    );
    return "deleted";
  } catch (cause) {
    // 55P03 is `lock_not_available` — the delete was made to wait and gave up, which is the
    // answer this file is looking for. Anything else is a real failure and travels as itself.
    if ((cause as { code?: string }).code === "55P03") return "waited";
    throw cause;
  }
}
