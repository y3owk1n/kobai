import { type Field, notUsable } from "../patch.ts";

/**
 * A Product's **status** — whether a Shopper may see it at all.
 *
 * One module for `handle.ts`'s reason: four places have to agree about the same three words and
 * disagreeing would be invisible. `db/schema.ts` constrains the column to them, `http/contract.ts`
 * builds the enum a request is checked against out of {@link PRODUCT_STATUSES}, `catalog/update.ts`
 * narrows a correction with {@link productStatusField}, and `catalog/store-read.ts` reads
 * {@link PUBLISHED} and nothing else. A fourth status added to one of those and not the others
 * would be a Product the schema accepts and the storefront cannot explain.
 *
 * **A Product is created a draft and published as a separate act** (story 6). `POST
 * /admin/products` carries no status at all — the column's default is what a create gets — and
 * `PATCH /admin/products/{id}` is where publishing and archiving happen. Publishing on creation
 * would make it a side effect of typing a title rather than a decision, which is precisely what
 * the story asks for the other way round.
 *
 * **The three partition the catalog, and only the middle one is public.** A draft is being
 * prepared, a published Product is for sale, and an archived one has left the storefront without
 * taking the Orders that reference it with it (ADR-0009 — an Order's Line Items are a snapshot,
 * so archiving rewrites nothing anybody has been charged for). That is why archiving exists at
 * all rather than deletion: `DELETE /admin/products/{id}` still removes a Product from the
 * catalog outright, and it is the wrong instrument for something that has been sold.
 *
 * **The set is closed and the column carries a `check`**, which is the opposite judgement from
 * `handle`'s and from `core_variant.fulfilment_strategy`'s, for the reason `core_api_key.kind`
 * carries one: those two are open sets a rule or a deployment may widen, and this is three words
 * Core owns entire. Nothing outside Core can invent a fourth, so a row holding one is a bug
 * rather than a Merchant's choice.
 */

/**
 * The three, in the order a Product moves through them.
 *
 * A tuple rather than a union alone, because it is read at runtime three ways: `contract.ts`
 * builds `z.enum` from it, `db/schema.ts` writes the `check` from it, and
 * {@link productStatusField} tells a Merchant which words there are. One list, so a fourth is
 * one edit and a migration rather than four edits and whichever one was forgotten.
 */
export const PRODUCT_STATUSES = ["draft", "published", "archived"] as const;

/** Whether a Shopper may see this Product, and what a Merchant has decided about it. */
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/**
 * What a Product is created as, and what the column defaults to.
 *
 * A **default** rather than a backfill, and the distinction is ADR-0038's: this is the right
 * value for every row written from here on, so it belongs in `schema.ts` where it is visible.
 * What the rows that already existed had to become is `published`, which is a different value —
 * and a value that has to be different for the rows already there is a backfill, which is why
 * this column cost three migrations rather than one.
 */
export const DRAFT = "draft" satisfies ProductStatus;

/**
 * The one status the store surface answers with.
 *
 * Read by `catalog/store-read.ts` in the route rather than offered as a filter, because a client
 * that could ask for drafts is a client that will: a storefront must not be able to publish what
 * a Merchant has not.
 */
export const PUBLISHED = "published" satisfies ProductStatus;

/**
 * How a `status` a request carried is narrowed.
 *
 * A {@link Field} because `PATCH /admin/products/{id}` reads its body with one, and the route's
 * own schema has already refused anything outside the enum at 400 — so this is reached only by a
 * caller that went round the schema, and it says the same thing that schema does rather than
 * trusting the parse. There is no `null` for it as there is for a description: a Product with no
 * status is not a state kobai has, which is what the `NOT NULL` column already says.
 */
export const productStatusField: Field<ProductStatus> = (value) => {
  const asked = PRODUCT_STATUSES.find((status) => status === value);
  if (asked === undefined) {
    return notUsable(
      `\`status\` must be one of ${PRODUCT_STATUSES.map((status) => `\`${status}\``).join(", ")}. A Product is prepared as a draft, published when it is ready, and archived when it should leave the storefront without taking its Orders with it.`,
    );
  }
  return { ok: true, value: asked };
};
