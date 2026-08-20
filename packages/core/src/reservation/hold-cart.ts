import type { Database } from "../db/client.ts";
import type { FulfilmentStrategies } from "../fulfilment/strategy.ts";
import {
  type LoadCartRefusal,
  readCartToPlace,
  reservableLinesOf,
} from "../order/load-cart.ts";
import type { ChannelIdentity } from "../store/channel.ts";
import type { ReservationClaim, ReservationRefusal } from "./provider.ts";
import { holdReservations } from "./reservation.ts";

/**
 * **Holding a Cart's stock before the Shopper leaves** — what
 * `POST /store/carts/{id}/reservations` does (ADR-0070).
 *
 * A redirect payment method takes the money at the bank rather than here: the Shopper authorises
 * in their banking app and the funds are gone before kobai is told anything. Until this route
 * existed the only thing that claimed stock was `hold-reservations`, *inside* `place-order`, so
 * nothing was held while the Shopper was away — pay, come back, and the placement refuses
 * `insufficient-inventory` with the money already taken. A storefront calls this first, and the
 * placement that follows **adopts** what it took.
 *
 * **It reads the Cart exactly as `load-cart` does**, through the same function, so the hold
 * covers the lines the placement will capture. A second reading would be a second answer, and a
 * hold that covered something else is worse than no hold at all.
 *
 * What it does *not* do is freeze the Cart. A Cart may still be changed while its stock is held —
 * that is what a Cart is (ADR-0009) — and holding again after a change re-holds it, which is
 * `holdReservations`' third case rather than this module's business.
 */

/** What a Cart is holding, and until when — the answer this route gives. */
export type CartHold = {
  readonly cartId: string;
  /**
   * The claims this Cart is holding, in whatever terms the provider that owns each one keeps
   * them: a Variant's identifier is Inventory's `subject`, and Capacity's will be its own key.
   *
   * Empty for a Cart of Variants nothing is counting — a Store selling downloads holds nothing
   * and needs to hold nothing (ADR-0014).
   */
  readonly reservations: readonly ReservationClaim[];
  /**
   * When the hold lapses, and the sweeper gives the units back.
   *
   * Absent when nothing is held, because then there is no deadline: a deadline reported for an
   * empty hold would be a promise about nothing, and a storefront that showed a Shopper a
   * countdown would be counting down to no consequence.
   */
  readonly expiresAt: Date | undefined;
};

/** Every way holding a Cart's stock can be refused, and all of them are Core's own. */
export type HoldCartRefusal = LoadCartRefusal | ReservationRefusal;

export type CartHoldResult =
  | { readonly ok: true; readonly hold: CartHold }
  | {
      readonly ok: false;
      readonly reason: HoldCartRefusal;
      readonly detail: string;
    };

/**
 * Claims everything scarce in this Cart, or adopts what it is already holding.
 *
 * **All of it or none of it**, exactly as holding inside a placement is: a Cart that can hold the
 * last poster but not the last mug claims neither, because the Shopper is told no either way and
 * the poster would be unsellable until the sweeper noticed.
 *
 * **Calling it twice for one Cart is safe and is the ordinary case** — a storefront retrying
 * after a timeout must not claim the stock twice — which is `holdReservations`' claim-or-adopt
 * and not a check here.
 */
export async function holdCartReservations(
  db: Database,
  cartId: string,
  strategies: FulfilmentStrategies | undefined,
  holdWindowMs: number,
  /**
   * The Channel the presented key is in, threaded because {@link readCartToPlace} carries one
   * (#293, ADR-0020).
   *
   * Nothing here reads it — a hold claims stock and prices nothing — and it is passed anyway
   * for this module's whole reason: the hold and the placement that adopts it read a Cart
   * through one function, so a second shape of that reading would be a second answer to what is
   * in a Cart. A parameter the hold route left out is exactly how `place-order` came to price
   * against no Channel at all.
   */
  channel: ChannelIdentity | null,
): Promise<CartHoldResult> {
  const read = await readCartToPlace(db, cartId, strategies, channel);
  if (!read.ok) return read;

  const held = await holdReservations(
    db,
    read.loaded.cart.id,
    // The same projection `hold-reservations` sends, from the same function, because it is the
    // same claim being made a few minutes earlier.
    reservableLinesOf(read.loaded),
    holdWindowMs,
  );
  if (!held.ok) return held;

  return {
    ok: true,
    hold: {
      cartId: read.loaded.cart.id,
      // The claim and not the row: a Reservation's identifier is Core's own handle on it, and
      // there is deliberately no route that releases one — a hold a storefront could give back
      // is one it could give back out from under a Shopper who is mid-payment.
      reservations: held.reservations.map(({ provider, subject, quantity }) => ({
        provider,
        subject,
        quantity,
      })),
      expiresAt: held.expiresAt,
    },
  };
}
