import type { FulfilmentState } from "@kobai/client";
import { Badge } from "@/components/ui/badge";

/**
 * What a Fulfilment's state is called on screen, in the order it moves through them.
 *
 * A `Record` keyed by `FulfilmentState`, for `product-status-badge.tsx`'s reason: the set is
 * **closed** in kobai's types, so a fifth state added in Core has no key here, does not compile,
 * and reddens this build in the same commit (ADR-0063). What this Admin may hold is what kobai's
 * types close; what a deployment decides it must ask about, which is why the Fulfilment
 * *Strategy* picker reads a route and this does not — the Strategy set is open and this one is
 * not, which is exactly ADR-0014's line.
 *
 * **What it deliberately does not hold is which transitions are legal.** That table is Core's and
 * is not published on the wire, so a copy here would be a second answer to a question this Admin
 * cannot see change. The Order screen offers all three controls and renders kobai's refusal.
 */
export const FULFILMENT_STATE_LABELS: Record<FulfilmentState, string> = {
  pending: "Not sent",
  dispatched: "Dispatched",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

/**
 * Where one part of an Order has got to — the only thing on an Order that moves (ADR-0014).
 *
 * **`pending` is the loud one**, on `ProductStatusBadge`'s argument turned round to point at the
 * same kind of Merchant: somebody opening an Order is looking for what still has to be sent.
 */
export function FulfilmentStateBadge({ state }: { readonly state: FulfilmentState }) {
  const label = FULFILMENT_STATE_LABELS[state];

  switch (state) {
    case "pending":
      return <Badge>{label}</Badge>;

    case "dispatched":
      return <Badge variant="secondary">{label}</Badge>;

    case "delivered":
      return <Badge variant="outline">{label}</Badge>;

    case "cancelled":
      // Destructive, and it is the one state on this record that earns it: a cancelled
      // Fulfilment is a part of a paid-for Order that is not going to arrive, which is a thing a
      // Merchant scanning the screen should see. It is not a refund — a Return is its own spec.
      return <Badge variant="destructive">{label}</Badge>;

    default: {
      // Unreachable, and it is the compiler that says so.
      const unreached: never = state;
      return unreached;
    }
  }
}
