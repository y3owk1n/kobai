import type { ProductStatus } from "@kobai/client";
import type { FilterOption } from "@/components/list-filter";
import { Badge } from "@/components/ui/badge";

/**
 * What a Product's status is called on screen, in the order a Product moves through them.
 *
 * A `Record` keyed by `ProductStatus` rather than an array of strings, for `lib/refusal.ts`'s
 * reason one noun along: the set is **closed** in kobai's types, so a fourth status added in Core
 * has no key here, does not compile, and reddens this build in the same commit (ADR-0063). What
 * this Admin may hold is what kobai's types close; what a deployment decides it must ask about,
 * which is why the Fulfilment Strategy picker reads a route and this does not.
 *
 * **One list of the words, read by all three places that show them** — the badge below, the
 * filter on the Products list, and the picker on a Product — because a badge reading `Published`
 * beside a filter reading `On sale` is one fact spelled two ways.
 */
export const PRODUCT_STATUS_LABELS: Record<ProductStatus, string> = {
  draft: "Draft",
  published: "Published",
  archived: "Archived",
};

/**
 * The three, in the order they are offered.
 *
 * `Object.keys` answers `string[]` whatever it was given, so the union is put back here — the one
 * place this module says a word about types the compiler took no part in, and the reason it is
 * safe is that the keys of a `Record<ProductStatus, …>` are exactly the three.
 */
export const OFFERED_STATUSES = Object.keys(
  PRODUCT_STATUS_LABELS,
) as readonly ProductStatus[];

/**
 * The three as a list of `{ value, label }`, which is what both a filter and a picker want.
 *
 * Built here rather than mapped at each call site, so the two really are the same list rather
 * than two mappings of one `Record` that happen to agree today.
 */
export const PRODUCT_STATUS_OPTIONS: readonly FilterOption<ProductStatus>[] =
  OFFERED_STATUSES.map((status) => ({
    value: status,
    label: PRODUCT_STATUS_LABELS[status],
  }));

/**
 * Whether a Shopper can see this Product — the one thing a Merchant scanning the catalog for
 * their drafts is reading for.
 *
 * **Three answers that partition the catalog**, which is kobai's own rule rather than this
 * component's: a Product is created a `draft`, becomes `published` when a Merchant decides it is
 * ready, and is `archived` to take it off the storefront without touching the Orders that
 * reference it. `ProductStatus` in the API description says exactly that, and
 * `GET /admin/products?status=` narrows by it.
 *
 * Unlike `CartStateBadge` beside it there is nothing to derive: the route answers the word, so
 * this renders it. What the two share is the `never` at the bottom — a fourth status added in
 * Core has no arm here and reddens this build in the same commit (ADR-0063). What is chosen here
 * is only the **recipe**, the words coming from {@link PRODUCT_STATUS_LABELS} above.
 *
 * **`published` is the quiet one and `draft` is the loud one**, which is the opposite of the Cart
 * list's emphasis and is right for the same reason: a Merchant comes to this screen to find what
 * is *not* on sale yet. Published is the ordinary state of a working catalog.
 */
export function ProductStatusBadge({ status }: { readonly status: ProductStatus }) {
  const label = PRODUCT_STATUS_LABELS[status];

  switch (status) {
    case "draft":
      return <Badge>{label}</Badge>;

    case "published":
      return <Badge variant="secondary">{label}</Badge>;

    case "archived":
      // Not destructive: archiving is the safe way to take something off the storefront, and the
      // Orders placed from it are untouched (ADR-0009). Deleting is the destructive one and it
      // has its own control.
      return <Badge variant="outline">{label}</Badge>;

    default: {
      // Unreachable, and it is the compiler that says so.
      const unreached: never = status;
      return unreached;
    }
  }
}
