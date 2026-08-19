import type { CartState, CartSummary } from "@kobai/client";
import { Badge } from "@/components/ui/badge";

/**
 * What has become of a Cart — the one thing a Merchant scanning this list is reading for.
 *
 * **Three answers that partition the table**, which is kobai's own rule rather than this
 * component's: a Cart that became an Order is `spent` whatever its deadline says, one that has
 * not and is past its deadline is `expired`, and everything else is `live`. `CartState` in the
 * API description says exactly that, and `GET /admin/carts?state=` narrows by it.
 *
 * The route answers `expired` and `placed` as **booleans** rather than answering the word, so
 * the word is derived here — {@link stateOf} — and that is a rendering rather than a rule this
 * Admin has an opinion about: the derivation is the partition the description states, in the one
 * place a screen needs a label. What must not happen is this browser deciding *whether* a Cart
 * has expired, which is why `expired` is a field the server judges and never `expiresAt`
 * compared against a clock in a browser.
 *
 * **`live` is the loud one**, and that is the whole point of the screen: it is a Cart that can
 * still be placed and, once a storefront holds stock before sending a Shopper to their bank
 * (ADR-0070), it is the answer to *why is that stock unavailable?* The other two are history.
 */
export function CartStateBadge({ cart }: { readonly cart: CartSummary }) {
  const state = stateOf(cart);

  switch (state) {
    case "live":
      return <Badge>Live</Badge>;

    case "expired":
      // Not destructive: a Cart running out of time is the ordinary end of most Carts, and the
      // stock it was holding is already back on the shelf.
      return <Badge variant="outline">Expired</Badge>;

    case "spent":
      return <Badge variant="secondary">Spent</Badge>;

    default: {
      // Unreachable, and it is the compiler that says so — a fourth `CartState` in Core has no
      // arm here and reddens this build in the same commit (ADR-0063).
      const unreached: never = state;
      return unreached;
    }
  }
}

/**
 * Which of the three a Cart is in, off the two facts the route reports.
 *
 * The order matters and is the description's: **`placed` wins**, because a Cart that became an
 * Order is spent whatever its deadline says — and a spent Cart that had also lapsed would
 * otherwise be reported as expired, which is the one reading that would send a Merchant looking
 * for stock nobody is holding.
 */
export function stateOf(cart: Pick<CartSummary, "expired" | "placed">): CartState {
  if (cart.placed) return "spent";
  return cart.expired ? "expired" : "live";
}
