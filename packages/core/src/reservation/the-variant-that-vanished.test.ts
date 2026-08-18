import { describe, expect, it } from "vitest";
import {
  createTestKobai,
  seedTestCatalog,
  signInTestMerchant,
  type TestKobai,
} from "../testing/index.ts";

/**
 * **A Merchant counts a shelf while another Merchant takes it away** — the smaller sibling of
 * the race `the-last-unit.test.ts` is about, on the path where nobody's money is involved.
 *
 * `PUT /admin/variants/{id}/inventory` declares a 404 `variant-not-found`, and until #145 that
 * refusal was made by a `select` whose answer stopped being true a moment later: the Variant was
 * read, and the row counting it was written in a second statement with nothing holding the first
 * answer in place. A `DELETE /admin/variants/{id}` landing in between left the write pointing at
 * a Variant that had gone, which Postgres refuses as a foreign-key violation — a **500** to a
 * Merchant whose only mistake was counting something a colleague was deleting.
 *
 * ADR-0018 is the rule this file applies away from stock: a check and the write it authorises
 * are one operation, or they are two facts that can disagree. `inventoryProvider.hold` says so
 * in as many words about the shelf; the count path is the same argument about the Variant's
 * existence, and it now holds `for share` on the `core_variant` row for the length of the
 * transaction it writes in — the same lock `setPrice`, `addCartLine` and `capture-order` take
 * before writing a row that references a Variant, and taking it before `core_inventory`, which
 * is the tail of the `core_product` → `core_variant` → `core_inventory` order every site holding
 * more than one of those rows takes them in (ADR-0059). A count holds no Product row at all.
 *
 * **It was watched failing before it was made to pass.** Against the two loose statements, the
 * counts that arrived while a delete was open answered
 * `500 {"error":"Internal Server Error"}` — eighteen of twenty-four across ten runs, and six of
 * six on the run this file was written against — while every delete answered 204. The Store was
 * never wrong about anything; only the Merchant was told the server was broken instead of that
 * the Variant was gone.
 *
 * **That failing run is the whole of the proof the gap is reached, and it has to be**, because
 * no assertion below can say so. The fix makes a count that landed in the gap and a count that
 * arrived after the delete had committed answer the *same* 404 — which is the point of it — so
 * a green run here cannot tell a contended race from an arrangement that stopped overlapping.
 * Nothing about that is unique to this file: it is why `the-last-unit.test.ts` writes down what
 * its run did too. Changing how these requests are dispatched means watching this fail again.
 */

/**
 * How many Merchants count a Variant another Merchant is deleting, at the same instant.
 *
 * The window is open only while a delete's transaction is, so more than one attempt is wanted:
 * a count that arrives after the delete has committed is answered 404 honestly by any
 * implementation and proves nothing. Six is what the failing runs above were measured with, and
 * it reached the gap on every one of them — a single pair reached it on roughly half. It is also
 * small enough to stay well inside the connection pool, because queueing behind connections
 * would serialise the very thing this exists to overlap.
 */
const CONTENDED_VARIANTS = 6;

/** What each Merchant says they counted — any number, and the same one, so a 200 can be read. */
const COUNTED_AT = 7;

describe("counting a Variant that is being deleted", () => {
  it("answers the refusal the route declares, never a broken server", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    // A Product each, because `deleteVariant` takes `for update` on the Product before it counts
    // siblings (ADR-0059) — Variants of one Product would queue behind each other, and five of
    // the six deletes would be waiting rather than racing. The spare Variant is what keeps every
    // Product with at least one (ADR-0008), so the delete is not refused `last-variant`.
    const catalogs = await Promise.all(
      Array.from({ length: CONTENDED_VARIANTS }, (_, index) =>
        seedTestCatalog(kobai, {
          merchant,
          variants: [{ sku: `COUNTED-${index}` }, { sku: `SPARE-${index}` }],
        }),
      ),
    );
    const variantIds = catalogs.map(
      (catalog, index) => catalog.variant(`COUNTED-${index}`).id,
    );

    // Every delete first and every count immediately behind it, all in flight together: the
    // window a count has to land in is the length of a delete's transaction, so a count
    // dispatched in front of one would simply win and never reach the gap.
    const deleting = variantIds.map((id) =>
      kobai.request(`/admin/variants/${id}`, {
        method: "DELETE",
        headers: merchant.headers,
      }),
    );
    const counting = variantIds.map((id) =>
      kobai.request(`/admin/variants/${id}/inventory`, {
        method: "PUT",
        headers: { ...merchant.headers, "content-type": "application/json" },
        body: JSON.stringify({ onHand: COUNTED_AT }),
      }),
    );
    const [counted, deleted] = await Promise.all([
      Promise.all(counting),
      Promise.all(deleting),
    ]);

    // Two answers are true here and the race decides which: the count got in first — and then
    // says what it counted, or a 200 that wrote nothing would read as a pass — or the Variant
    // had gone. A third answer is the bug, and `500 undefined` is what it reads as, because a
    // foreign-key violation carries no `reason` for anybody to branch on.
    const answers = await Promise.all(counted.map(describeAnswer));
    expect(
      answers.filter(
        (answer) =>
          answer !== `200 onHand=${COUNTED_AT}` && answer !== "404 variant-not-found",
      ),
    ).toEqual([]);

    // And no delete was disturbed by the count it raced. This is the other direction, and it is
    // the one a lock can break: a count holding a row a delete wants, in an order no other site
    // takes them in, would deadlock, and Postgres would resolve that by killing one of them.
    expect(deleted.map((response) => response.status)).toEqual(
      Array(CONTENDED_VARIANTS).fill(204),
    );

    // The database agrees with both answers, which is what makes them the same answer: every
    // counted Variant is gone, and so is every row counting one — a 200 wrote an Inventory row
    // that the delete then took with it, and a 404 never wrote one.
    await expect(inventoryRowCount(kobai)).resolves.toBe(0);
    for (const catalog of catalogs) {
      const product = await kobai.request(`/admin/products/${catalog.productId}`, {
        headers: merchant.headers,
      });
      await expect(product.json()).resolves.toMatchObject({
        variants: [{ inventory: null }],
      });
    }
  });
});

/**
 * What a count answered, as the one string both halves of it can be judged by.
 *
 * Read as text and parsed from there, because the answer this exists to catch is the one nobody
 * designed: a body that is not JSON would throw here and the failure would name the parse rather
 * than the status, which is the wrong thing to be told.
 */
async function describeAnswer(response: Response): Promise<string> {
  const text = await response.text();
  const body = parsed(text);
  if (response.status === 200) return `200 onHand=${body.onHand}`;
  return `${response.status} ${body.reason ?? text}`;
}

function parsed(text: string): { reason?: string; onHand?: number } {
  try {
    return JSON.parse(text) as { reason?: string; onHand?: number };
  } catch {
    return {};
  }
}

/** Rows counting anything at all — asked of the database, because a cascade is its work. */
async function inventoryRowCount(kobai: TestKobai): Promise<number> {
  const rows = await kobai.database.query<{ id: string }>(
    "select id from core_inventory",
  );
  return rows.length;
}
