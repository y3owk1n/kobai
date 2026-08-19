import { isUuid } from "../db/uuid.ts";
import { type Field, notUsable } from "../patch.ts";

/**
 * A Product's **handle** — the address it is known by, so that a storefront's URL can be
 * `/products/blue-poster` rather than a UUID.
 *
 * One module, because three callers have to agree about the same string and disagreeing would
 * be invisible: `catalog/write.ts` proposes one from a title and accepts one a Merchant gave,
 * `catalog/update.ts` accepts a correction, and `catalog/store-read.ts` resolves one. A shape
 * read one way in a create and another in a `PATCH` is a Product a Merchant can make and then
 * cannot correct.
 *
 * **A handle is refused two ways and both are `invalid`, so this route adds one `reason` to the
 * promised surface rather than three** (ADR-0060). The one it adds is `handle-taken`, which is a
 * fact about the Store rather than about the request and is the module's own to answer — the
 * two below are properties of the string itself, which is what `invalid` already means
 * everywhere on this surface.
 *
 * - **Not the shape of an address.** Lower-case ASCII letters and digits in runs separated by
 *   single hyphens, which is exactly what {@link slugify} produces — so what kobai proposes is
 *   what kobai accepts. It is narrower than the column, deliberately: a handle carrying a `/`,
 *   a space or a `%` is one no path can carry, which is the same failure as the UUID below
 *   arriving through a different character. It is also, deliberately, ASCII — a Store whose
 *   titles are in a script this leaves nothing of gives every Product a handle of its Merchant's
 *   own choosing rather than a mangled one, and widening this later is additive where narrowing
 *   it would be a break.
 * - **The shape of an identifier.** `GET /store/products/{idOrHandle}` reads a UUID as an id and
 *   anything else as a handle, which is the rule that makes that route statable at all — so a
 *   Product whose handle looked like a UUID would be unreachable by its own address. Refusing it
 *   at creation is what keeps the resolution a rule rather than a guess.
 *
 * There is no `check` on the column for either. What a handle may look like is a rule about a
 * request and may be relaxed; a Product stored before the relaxation must still be readable, and
 * a constraint is the one place a relaxation cannot reach rows already written. The same
 * asymmetry is why `core_variant.fulfilment_strategy` carries no `check` (ADR-0014).
 */

/** Lower-case ASCII in runs separated by single hyphens — what {@link slugify} produces. */
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A title, reduced to the address it suggests — `"Blue Poster (A2)"` becomes `blue-poster-a2`.
 *
 * Five steps, and the middle two are the ones that are not obvious. Lower-cased; decomposed to
 * NFD, so `é` becomes an `e` followed by a combining accent; **that accent then deleted rather
 * than collapsed**, so `Café Crème` proposes `cafe-creme` and not `cafe-cre-me`; every run of
 * anything left outside `a-z0-9` collapsed to a single `-`; and the hyphens trimmed off both
 * ends. Deleting is what tells an accent from a separator: a `★` between two words really is a
 * gap, and a mark over a letter is that letter.
 *
 * The range deleted is `U+0300`–`U+036F`, Unicode's Combining Diacritical Marks, written out
 * rather than as `\p{M}` — **because Postgres has no `\p{…}` and the backfill has to delete
 * exactly the same characters.** A wider class expressible only on this side would be a rule
 * the two implementations quietly disagree about. What follows from choosing the Latin range is
 * that a title in a script NFD leaves whole proposes nothing at all, which is the honest answer
 * for an ASCII address: the Merchant is asked for one instead.
 *
 * **`packages/core/migrations/0037_backfill_product_handles.sql` derives the same string in
 * SQL**, so a Product from before this column and one created after it are addressed by one
 * rule. Two implementations is the price of a backfill being SQL; that they agree is asserted
 * against a real Postgres in `two-products-one-handle.test.ts`, which is the only place a
 * comparison of the two is worth anything.
 *
 * It may answer `""`, and every caller has to say what it does about that: a title with nothing
 * addressable in it is a real title and not a bad one.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

/**
 * The handle a Product created without one gets, or `undefined` where its title suggests none
 * kobai may use.
 *
 * `undefined` covers the two cases {@link slugify} cannot answer for: a title that leaves
 * nothing addressable behind, and one that reduces to something that would be read as an
 * identifier — a Product literally titled with a UUID. Both are refused at creation rather than
 * papered over, because there is a Merchant there to be asked, and a handle chosen for them out
 * of nothing is one they would find out about from their storefront.
 *
 * **The backfill answers differently, and that asymmetry is the decision rather than a
 * divergence**: `0037` has nobody to ask and a Store with rows to migrate, so it falls back to
 * `product` and numbers it. Refusing there would be a deployment that will not boot.
 */
export function proposeHandle(title: string): string | undefined {
  const proposed = slugify(title);
  if (proposed === "" || isUuid(proposed)) return undefined;
  return proposed;
}

/**
 * How a `handle` a request carried is narrowed, wherever it arrives — a create's body and a
 * correction's alike.
 *
 * A {@link Field} because that is what `PATCH /admin/products/{id}` reads its body with, and
 * `POST /admin/products` calls the same function rather than restating the two refusals: one
 * shape read one way, so a handle a Merchant can create is a handle they can correct to.
 */
export const handleField: Field<string> = (value) => {
  if (typeof value !== "string" || value.trim() === "") {
    return notUsable(
      '`handle` must be a non-empty string — the address this Product is known by, e.g. "blue-poster". Leave it out and kobai proposes one from the title.',
    );
  }

  const asked = value.trim();

  // Asked before the shape, because it is the more surprising of the two and a Merchant who
  // pasted an identifier in should be told what happened rather than shown a grammar. A UUID
  // satisfies the shape below, which is exactly why this cannot be left to it.
  if (isUuid(asked)) {
    return notUsable(
      "`handle` must not look like an identifier. `GET /store/products/{idOrHandle}` reads a UUID as a Product's id and anything else as its handle, so a Product whose handle were one could not be reached by its own address.",
    );
  }

  if (!HANDLE.test(asked)) {
    return notUsable(
      '`handle` is an address, so it is lower-case letters and digits in groups separated by single hyphens — "blue-poster", not "Blue Poster". It is what appears in a storefront URL, which is why it carries no spaces, no slashes and no punctuation.',
    );
  }

  return { ok: true, value: asked };
};

/**
 * What a request naming a handle another Product already answers to is told — creating a
 * Product, and correcting one.
 *
 * One sentence for both, because it is one fact about the Store rather than about the route: an
 * address two Products share addresses neither. It is deliberately **not** resolved by
 * suffixing, the way `0037` resolves it for rows nobody can be asked about — a Merchant who
 * asked for `blue-poster` and silently got `blue-poster-2` would find out from their storefront,
 * and the backfill only numbers because there is no one to tell.
 */
export function handleTaken(handle: string) {
  return {
    ok: false,
    reason: "handle-taken",
    detail: `Another Product already answers to ${JSON.stringify(handle)}. A handle is the address a Product is reached at, so it cannot name two.`,
  } as const;
}

/**
 * What a create whose title suggests no usable handle is told, when it named none of its own.
 *
 * It is a refusal rather than a fallback for the reason {@link proposeHandle} answers
 * `undefined` at all: a Merchant is there, and `blue-poster` is worth asking one question for.
 */
export function noHandleToPropose(title: string) {
  return notUsable(
    `kobai could not propose a handle from the title ${JSON.stringify(title)} — it leaves no letters or digits behind, or it reads as an identifier. Name a \`handle\` of your own: it is the address this Product is reached at, e.g. "blue-poster".`,
  );
}
