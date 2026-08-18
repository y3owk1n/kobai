import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database, Queryable, Transaction } from "../db/client.ts";
import { violatesCheckConstraint } from "../db/errors.ts";
import { inventory, variant } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import type {
  HoldOutcome,
  ReservableLine,
  ReservationClaim,
  ReservationProvider,
} from "./provider.ts";

/**
 * **Inventory** — the countable stock of a physical Variant, and the first (today the only)
 * Reservation provider (ADR-0018, `CONTEXT.md`).
 *
 * Two audiences in one module, because both are the same two numbers. A Merchant sets what the
 * Store has and reads back what is left; the Workflow claims units, takes them and gives them
 * back. Splitting them across two files would put the arithmetic that must agree in two places.
 *
 * **Two things have to be true before a unit is claimed**, and they answer different questions.
 * The Variant's Fulfilment Strategy says whether selling one takes anything off a shelf at all
 * (ADR-0014) — a digital Variant is skipped here whether or not somebody has counted it — and a
 * row in this table says how many there are. **A Variant with no row is not tracked**, which is a
 * different thing from one with none left: it sells freely, and no Reservation is held for it.
 * That is what makes this provider safe to ask about every line of every Cart.
 */

/** What Inventory reports about one Variant, and the shape a Merchant reads. */
export type VariantInventory = {
  readonly variantId: string;
  /** What the Store physically has. */
  readonly onHand: number;
  /** How much of it is claimed by Reservations still held. */
  readonly reserved: number;
  /** What is left to sell: `onHand - reserved`, derived here and stored nowhere. */
  readonly available: number;
};

/** Setting stock refuses in two ways, and both are the Merchant's to fix. */
export type InventoryUpdate =
  | { readonly ok: true; readonly inventory: VariantInventory }
  | {
      readonly ok: false;
      readonly reason: "variant-not-found" | "stock-is-reserved";
      readonly detail: string;
    };

/**
 * Sets what the Store has of a Variant — a statement of fact, not a delta.
 *
 * A count rather than an adjustment because that is what a Merchant is in a position to know:
 * they have just counted the shelf. `+3` would need every caller to agree about what it was
 * being added to, and two Merchants counting the same shelf at once would end up with six.
 *
 * The first call is what makes the Variant **tracked**; later ones correct it. `reserved` is
 * never touched here — it belongs to the Reservations in flight, and a Merchant counting a
 * shelf is not making a statement about those.
 *
 * **The Variant is locked, and the answer about it is therefore still true when the row is
 * written** (ADR-0018, #145). "This Variant exists" and "count it at seven" are two statements,
 * and until they were one transaction holding the `core_variant` row, a `DELETE
 * /admin/variants/{id}` landing between them left the write referencing a Variant that had
 * gone: a foreign-key violation, and a **500** where this route declares a 404.
 *
 * That is ADR-0018's rule applied to a different fact, not an exception to it.
 * `inventoryProvider.hold` makes the check and the write **one statement** because the fact it
 * checks — how many units are free — is a column it is also writing. Existence is not: no single
 * statement can both check that a Variant is there and depend on it still being there, so the
 * ADR's *other* answer is the one available here, and a **row lock** is what makes the two
 * statements one operation. What stays forbidden either way is the plain read the delete routes
 * made a lie of. `for share` rather than `for update` because two Merchants counting the same
 * shelf have no quarrel with each other — only with a delete, which this blocks — and it is the
 * same lock `setPrice`, `addCartLine` and `capture-order` take before writing a row that
 * references a Variant.
 *
 * **The order is `core_variant` then `core_inventory`**, which is the tail of the
 * `core_product` → `core_variant` → `core_inventory` order `capture-order` and both delete
 * routes take those rows in (ADR-0059) — this takes no Product lock at all, and a prefix nobody
 * holds cannot make a cycle. The opposite order is a deadlock, and Postgres resolves one of
 * those by killing a request that was merely simultaneous.
 *
 * **Reading the violation instead was rejected, and not on cost.** A `violatesForeignKey` beside
 * `violatesCheckConstraint`, mapped to this same `variant-not-found`, would answer correctly and
 * add no lock to a write that is otherwise contention-free — it is the cheaper of the two. What
 * it does is answer *after* the state rather than keep the state from arising, which leaves the
 * loose read in place and makes the declared refusal a rescue rather than a decision; and it
 * would give this one hazard a second mechanism, where `setPrice`, `addCartLine` and
 * `capture-order` all already have the first. The `stock-is-reserved` refusal below **is** read
 * out of a violation, and that is the distinction rather than an inconsistency: a Reservation may
 * claim a unit between any read of `reserved` and this write, so nothing this transaction can
 * hold makes such a read stay true, and the `check` is what makes it one operation at all — the
 * other of the two mechanisms ADR-0018 names.
 */
export async function setInventory(
  db: Database,
  variantId: string,
  input: { readonly onHand: number },
): Promise<InventoryUpdate> {
  if (!isUuid(variantId)) return noSuchVariant(variantId);

  try {
    return await db.transaction(async (tx) => {
      const [exists] = await tx
        .select({ id: variant.id })
        .from(variant)
        .where(eq(variant.id, variantId))
        .for("share")
        .limit(1);
      if (!exists) return noSuchVariant(variantId);

      const [row] = await tx
        .insert(inventory)
        .values({ variantId, onHand: input.onHand })
        // The upsert is what makes "tracked" arrive with the first count rather than needing a
        // route of its own — and it is one statement, so two Merchants counting the same shelf
        // at the same instant produce one row rather than a unique-violation for the loser.
        .onConflictDoUpdate({
          target: inventory.variantId,
          set: { onHand: input.onHand },
        })
        .returning({ onHand: inventory.onHand, reserved: inventory.reserved });
      if (!row) throw new Error("Setting Inventory returned no row.");

      return { ok: true, inventory: reported(variantId, row) } as const;
    });
  } catch (cause) {
    // The database refuses a count below what is already claimed, because `reserved <= on_hand`
    // is a constraint rather than a convention (see `db/schema.ts`). It is a real conflict with
    // the state of the Store rather than a malformed request: some of this stock is spoken for,
    // and it either becomes an Order or the sweeper gives it back.
    //
    // Read out here rather than inside the transaction: a statement Postgres refused has already
    // aborted it, so a refusal decided in there would be returned from a transaction that can no
    // longer run anything, and the `commit` closing it would silently be a rollback.
    if (violatesCheckConstraint(cause, RESERVED_WITHIN_STOCK)) {
      return {
        ok: false,
        reason: "stock-is-reserved",
        detail: `This Variant cannot be counted at ${input.onHand}: more than that is currently claimed by Reservations being placed. Those either become Orders or lapse, and this count can be set once they have.`,
      };
    }
    throw cause;
  }
}

/**
 * What is known about each of these Variants, keyed by Variant — with nothing at all for the
 * ones that are not tracked.
 *
 * Absent rather than zeroed, because the difference is the whole of what a row means here: a
 * Variant nobody has counted sells freely, and one counted at zero sells to nobody.
 */
export async function readInventoryOf(
  db: Queryable,
  variantIds: readonly string[],
): Promise<Map<string, VariantInventory>> {
  if (variantIds.length === 0) return new Map();

  const rows = await db
    .select({
      variantId: inventory.variantId,
      onHand: inventory.onHand,
      reserved: inventory.reserved,
    })
    .from(inventory)
    .where(inArray(inventory.variantId, [...variantIds]));

  return new Map(rows.map((row) => [row.variantId, reported(row.variantId, row)]));
}

/**
 * Which of these Variants have units claimed right now — and the rows locked while the caller
 * decides what to do about it.
 *
 * Asked by the delete routes, which must not take a Variant away from an Order that is being
 * placed for it: the hold has already been made and the Shopper is about to be charged, and
 * that is the one thing about a deletion nothing could undo afterwards.
 *
 * **`reserved` is the question, not the `core_reservation` rows.** What makes a unit
 * unavailable is this provider's own arithmetic — the record says who claimed what and Core
 * owns it — so asking the column keeps one answer to "is this spoken for" rather than two that
 * can disagree, and it is exactly the fact the `reserved <= on_hand` constraint already refuses
 * a recount against. A hold that has lapsed but not yet been swept still counts here, for the
 * same reason and with the same fix: the sweeper gives the units back within the minute
 * (`sweep.ts`), and then the delete goes through.
 *
 * `for update` rather than a plain read, because a hold placed a moment after the answer would
 * make it a lie. It is taken **after** the caller has locked the `core_variant` rows, which is
 * the order `capture-order` takes them in too — the opposite order is a deadlock.
 *
 * **It answers for Inventory alone, and it lives here for that reason.** Only this module knows
 * a Reservation's `subject` is a Variant's identifier, and only this provider's arithmetic is
 * being read. The day a second provider can claim something *about a Variant* — a Capacity
 * claim on a period, say (ADR-0018) — a caller asking "may this Variant go" has to ask the
 * providers rather than this column, and a delete route leaning on this one would be quietly
 * answering half the question.
 */
export async function variantsWithClaimedStock(
  tx: Transaction,
  variantIds: readonly string[],
): Promise<readonly string[]> {
  if (variantIds.length === 0) return [];

  const rows = await tx
    .select({ variantId: inventory.variantId, reserved: inventory.reserved })
    .from(inventory)
    .where(inArray(inventory.variantId, [...variantIds]))
    .for("update");

  return rows.filter((row) => row.reserved > 0).map((row) => row.variantId);
}

/**
 * The Inventory provider — Core's answer to ADR-0018's interface, and the only implementation
 * of it until Capacity arrives.
 *
 * Its `subject` is a Variant's identifier, which is why nothing else in this repository has to
 * know that: `core_reservation.subject` is text, Core stores it, and only this module reads it
 * as an identifier.
 */
export const inventoryProvider: ReservationProvider = {
  name: "inventory",

  async claimsFor(db, lines) {
    // The Strategy decides *whether* this provider is in play at all, and the row decides how
    // many there are. A line whose Strategy says it consumes no stock is skipped here — not
    // claimed for zero — so a Store selling downloads takes no lock and writes no Reservation
    // (ADR-0014, ADR-0052).
    const wanted = combined(lines.filter((line) => line.fulfilment.tracksInventory));
    const tracked = await readInventoryOf(db, [...wanted.keys()]);

    // Only the Variants this provider is counting. A line for an untracked Variant produces no
    // claim at all, which is what makes a digital Variant sellable without a row.
    return [...wanted]
      .filter(([variantId]) => tracked.has(variantId))
      .map(([variantId, quantity]) => ({
        provider: "inventory",
        subject: variantId,
        quantity,
      }));
  },

  async hold(tx, claims) {
    for (const claim of ordered(claims)) {
      /**
       * **One statement: the check *is* the claim** (ADR-0018).
       *
       * The condition and the write are the same `update`, so Postgres takes the row lock
       * before it evaluates anything: a second request arriving mid-flight waits, and then —
       * under `read committed`, which is what this connection is on — re-evaluates the
       * condition against the row as the winner left it. It therefore sees the units already
       * reserved and matches nothing, which is what `rowCount === 0` means here.
       *
       * A `select` and then an `update` cannot do this and no amount of care makes it: both
       * requests read the same free unit, both write, and the Store has promised something
       * twice. `the-last-unit.test.ts` is the assertion, and it was watched failing against
       * exactly that implementation before this one replaced it.
       */
      const claimed = await tx
        .update(inventory)
        .set({ reserved: sql`${inventory.reserved} + ${claim.quantity}` })
        .where(
          and(
            eq(inventory.variantId, claim.subject),
            sql`${inventory.onHand} - ${inventory.reserved} >= ${claim.quantity}`,
          ),
        )
        .returning({ id: inventory.id });

      // Nothing matched: either there is not enough left, or the Variant stopped being counted
      // between `claimsFor` and here. Both are the same answer to a Shopper — the Store has not
      // got it — and neither is a fault in their request.
      if (claimed.length === 0) return shortOf(claim);
    }

    return { ok: true };
  },

  async consume(tx, claims) {
    for (const claim of ordered(claims)) {
      const taken = await tx
        .update(inventory)
        .set({
          onHand: sql`${inventory.onHand} - ${claim.quantity}`,
          reserved: sql`${inventory.reserved} - ${claim.quantity}`,
        })
        // Guarded rather than trusted. A hold the sweeper released while this run was still
        // going is the one way to arrive here with nothing to take, and selling the units
        // anyway is precisely the overselling ADR-0018 exists to prevent.
        .where(
          and(
            eq(inventory.variantId, claim.subject),
            sql`${inventory.reserved} >= ${claim.quantity}`,
            sql`${inventory.onHand} >= ${claim.quantity}`,
          ),
        )
        .returning({ id: inventory.id });

      if (taken.length === 0) {
        throw new Error(
          `The Reservation on Variant ${claim.subject} was no longer held when the Order was captured, so its stock could not be consumed.`,
        );
      }
    }
  },

  async release(tx, claims) {
    for (const claim of ordered(claims)) {
      const given = await tx
        .update(inventory)
        .set({ reserved: sql`${inventory.reserved} - ${claim.quantity}` })
        // The guard keeps the column from going negative if this is ever reached twice; the
        // row that authorises the release is what actually makes it happen once (see
        // `reservation.ts`).
        .where(
          and(
            eq(inventory.variantId, claim.subject),
            sql`${inventory.reserved} >= ${claim.quantity}`,
          ),
        )
        .returning({ id: inventory.id });
      if (given.length > 0) continue;

      // Nothing moved, and the two ways that happens are not the same fact.
      const [counted] = await tx
        .select({ reserved: inventory.reserved })
        .from(inventory)
        .where(eq(inventory.variantId, claim.subject))
        .limit(1);

      // The Variant stopped being counted while the hold stood — a Merchant deleted it, and the
      // row went with it. There is genuinely nothing to give back, and saying so would leave the
      // Reservation unreleasable forever: this transaction rolls back, and the sweeper meets the
      // same row again every minute for the rest of the deployment's life.
      if (!counted) continue;

      // The row is there and holds less than this Reservation claimed, which nothing in Core can
      // produce — every path through this module adds before it subtracts. So it is a write from
      // outside (ADR-0004), and losing the release quietly would leave the row saying `released`
      // while the shelf never got the units back. It raises, this transaction rolls back with
      // `released_at` unset, and whoever is watching learns the number is wrong.
      throw new Error(
        `Releasing a Reservation on Variant ${claim.subject} found ${counted.reserved} reserved where it claimed ${claim.quantity}. Something outside kobai has written to this Inventory row; its stock is now wrong in a way nothing here can repair.`,
      );
    }
  },
};

/** Two lines for one Variant are one claim: one row, one conditional write, one refusal. */
function combined(lines: readonly ReservableLine[]): Map<string, number> {
  const wanted = new Map<string, number>();
  for (const line of lines) {
    wanted.set(line.variantId, (wanted.get(line.variantId) ?? 0) + line.quantity);
  }
  return wanted;
}

/**
 * The claims, in a fixed order — by subject, which is the only total order there is.
 *
 * Two Carts holding the same two Variants in different orders would otherwise take the two row
 * locks in opposite orders and deadlock, and Postgres would resolve that by killing one of
 * them: a Shopper told the server broke, for a purchase that was merely simultaneous.
 */
function ordered(claims: readonly ReservationClaim[]): readonly ReservationClaim[] {
  return [...claims].sort((left, right) => left.subject.localeCompare(right.subject));
}

function shortOf(claim: ReservationClaim): HoldOutcome {
  return {
    ok: false,
    reason: "insufficient-inventory",
    detail: `This Store does not have ${claim.quantity} of that Variant left to sell. Stock is claimed while an Order is being placed, so some of it may free up shortly.`,
  };
}

function noSuchVariant(variantId: string): InventoryUpdate {
  return {
    ok: false,
    reason: "variant-not-found",
    detail: `No Variant ${JSON.stringify(variantId)} exists, so there is nothing to count.`,
  };
}

/** One row, as both audiences read it — with `available` worked out rather than stored. */
function reported(
  variantId: string,
  row: { readonly onHand: number; readonly reserved: number },
): VariantInventory {
  return {
    variantId,
    onHand: row.onHand,
    reserved: row.reserved,
    available: row.onHand - row.reserved,
  };
}

/** The `check` that refuses a count below what is already claimed — see `db/schema.ts`. */
const RESERVED_WITHIN_STOCK = "core_inventory_reserved_within_stock";
