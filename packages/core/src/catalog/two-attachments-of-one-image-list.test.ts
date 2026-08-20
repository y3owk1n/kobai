import { describe, expect, it } from "vitest";
import {
  createTestKobai,
  seedTestCatalog,
  type TestCatalog,
  type TestKobai,
} from "../testing/index.ts";

/**
 * Two Merchants setting one Product's images at the same instant (#255).
 *
 * **`PATCH /admin/products/{id}` takes `media` as what the list should now *be***, so setting it
 * is a `delete` of every attachment the Product has and an `insert` of the ones it should have.
 * Two of those landing together are four statements interleaved, and it goes wrong **two
 * different ways** depending on whether the lists overlap — which is why there are two cases
 * here and not one. Each sees exactly one of them, and neither sees the other.
 *
 * **The guard is `lockMediaOf`, a `pg_advisory_xact_lock` per subject**, taken before either
 * statement. A **row** lock cannot do it, exactly as it cannot for `lockProductOptions`:
 * `lockProduct` is `for share`, and two `FOR SHARE` holders do not conflict in Postgres at all —
 * that lock keeps a `DELETE` out, which is existence, and serialises nothing against another
 * write of the same list. The row lock is still taken beside it, still only for that.
 *
 * **No sequential assertion can see any of this** — every case in `media.test.ts` passes against
 * a build with the advisory lock deleted — so these dispatch at once, in the shape
 * `two-corrections-of-one-option-list.test.ts` and `the-cart-that-held-twice.test.ts` set. Three
 * things about how they are written carry to the next one:
 *
 * - **Both were watched failing**, with the `lockMediaOf` call in `updateProduct` disabled: the
 *   first answered five 500s out of eight, each one the unique index on `(product_id, media_id)`
 *   meeting a row a concurrent `delete` had not removed; the second left the Product showing
 *   **all eight** images where each of the eight had asked for one. Changing how these
 *   requests are dispatched obliges you to watch them fail again — once the fix is in, a request
 *   that landed in the window and one that arrived after the other transaction committed answer
 *   identically, so a green run cannot tell a contended race from an arrangement that quietly
 *   stopped overlapping.
 * - **The overlapping case asserts on the responses and the disjoint one on the Store**, and
 *   that split is the point rather than an inconsistency: an aborted transaction rolls its own
 *   insert back, so eight colliding requests leave a perfectly tidy Product and a Merchant
 *   holding a 500. Asserting only on the final list would have made the first case green against
 *   the very build it exists to fail against — which was watched, and is why it is asserted the
 *   other way round.
 * - **Each request starts from a Product that already shows something**, so every one of them
 *   has a row to delete as well as a row to insert. A delete of nothing would hide the half of
 *   this that is about deletes missing.
 */

/**
 * How many attachments go at once.
 *
 * Big enough that more than one is inside the delete-then-insert window on any scheduling, and
 * small enough to stay well inside the connection pool — queueing behind connections would
 * serialise the very thing these tests exist to overlap, and it would do it invisibly.
 */
const AT_ONCE = 8;

/** A 2×3 PNG, built from the format's own header rather than checked in as a blob. */
function pngBytes(): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, 2);
  view.setUint32(20, 3);
  return bytes;
}

/** Uploads `count` images through the public route, and hands back their identifiers. */
async function uploadImages(
  kobai: TestKobai,
  catalog: TestCatalog,
  count: number,
): Promise<string[]> {
  const uploaded = await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const body = new FormData();
      body.set(
        "file",
        new File([pngBytes()], `image-${index}.png`, { type: "image/png" }),
      );
      const response = await kobai.request("/admin/media", {
        method: "POST",
        headers: catalog.merchant.headers,
        body,
      });
      expect(response.status, "the arrangement could not upload a Media").toBe(201);
      return ((await response.json()) as { readonly id: string }).id;
    }),
  );
  return uploaded;
}

/** What this Product shows now, as a read of it reports it. */
async function shownOn(kobai: TestKobai, catalog: TestCatalog): Promise<string[]> {
  const read = await kobai.request(`/admin/products/${catalog.productId}`, {
    headers: catalog.merchant.headers,
  });
  expect(read.status).toBe(200);
  const product = (await read.json()) as {
    readonly media: readonly { readonly id: string }[];
  };
  return product.media.map((one) => one.id);
}

describe("two attachments of one image list", () => {
  it("does not turn the same image asked for twice at once into a 500", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const headers = { ...catalog.merchant.headers, "content-type": "application/json" };
    const [first, second] = await uploadImages(kobai, catalog, 2);

    const attached = await kobai.request(`/admin/products/${catalog.productId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ media: [{ id: first }] }),
    });
    expect(attached.status, "the arrangement could not attach an image").toBe(200);

    const answers = await Promise.all(
      Array.from({ length: AT_ONCE }, () =>
        kobai.request(`/admin/products/${catalog.productId}`, {
          method: "PATCH",
          headers,
          // The **same** image every time, which is what makes the two lists overlap: each
          // request deletes a row the request before it has not committed the deletion of, and
          // then inserts one the unique index has already seen.
          body: JSON.stringify({ media: [{ id: second }] }),
        }),
      ),
    );

    // **This is the assertion, and it has to be** — a transaction the index aborted rolls its own
    // insert back, so the Product is left perfectly tidy either way and only the caller knows.
    expect(answers.map((one) => one.status)).toEqual(Array(AT_ONCE).fill(200));
    await expect(shownOn(kobai, catalog)).resolves.toEqual([second]);
  });

  it("does not leave a Product showing the union of every list asked for at once", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const headers = { ...catalog.merchant.headers, "content-type": "application/json" };
    const images = await uploadImages(kobai, catalog, AT_ONCE + 1);
    const [starting, ...asked] = images;

    const attached = await kobai.request(`/admin/products/${catalog.productId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ media: [{ id: starting }] }),
    });
    expect(attached.status, "the arrangement could not attach an image").toBe(200);

    const answers = await Promise.all(
      asked.map((id) =>
        kobai.request(`/admin/products/${catalog.productId}`, {
          method: "PATCH",
          headers,
          // A **different** image each time, so no two inserts collide and the index catches
          // nothing. What is left is the deletes: each one sees the list as it stood before the
          // others wrote, removes what it finds, and leaves everything inserted since.
          body: JSON.stringify({ media: [{ id }] }),
        }),
      ),
    );
    expect(answers.map((one) => one.status)).toEqual(Array(AT_ONCE).fill(200));

    // Every one of these asked for a Product showing exactly one image, so whichever of them ran
    // last is what it shows — one, and one of the ones that were asked for.
    const shown = await shownOn(kobai, catalog);
    expect(shown).toHaveLength(1);
    expect(asked).toContain(shown[0]);
  });
});
