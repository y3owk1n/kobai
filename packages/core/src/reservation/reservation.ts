import { and, eq, gt, inArray, isNull, lt, type SQL, sql } from "drizzle-orm";
import type { Database, Transaction } from "../db/client.ts";
import { reservation } from "../db/schema.ts";
import { inventoryProvider } from "./inventory.ts";
import type {
  ReservableLine,
  ReservationClaim,
  ReservationProvider,
  ReservationRefusal,
} from "./provider.ts";

/**
 * Core's record of a **Reservation** — held, consumed, released — and the dispatch that puts
 * every provider through one mechanism (ADR-0018, ADR-0027).
 *
 * Nothing here knows what a Variant is. A claim names its provider and its subject and this
 * module writes the row, finds the provider again when the claim ends, and hands it back what
 * it claimed. That is what makes Capacity a second entry in {@link RESERVATION_PROVIDERS}
 * rather than a second copy of all of this.
 *
 * **Every operation is one transaction, and the row is what authorises the arithmetic.** A
 * compensation and the sweeper can reach the same held Reservation at the same instant, so the
 * `update … where released_at is null … returning` is what decides which of them actually gives
 * the units back — the other updates nothing and therefore releases nothing. The provider's own
 * arithmetic follows *inside that transaction*, so units are never returned twice and never
 * lost.
 */

/**
 * Every provider of scarce things this build of Core has.
 *
 * One today. Capacity is a second entry and nothing else: ADR-0018 promises one interface with
 * two providers, and the way that promise is kept is that this list is the only place a second
 * one has to appear. It is Core's own rather than a `kobai.config.ts` key — a Project supplying
 * a kind of scarcity is a decision nobody has taken, and taking it here by accident would make
 * the list a promised surface.
 */
export const RESERVATION_PROVIDERS: readonly ReservationProvider[] = [inventoryProvider];

/**
 * **How long a hold stands before the sweeper may give it back, for a Project that says
 * nothing.**
 *
 * Generous against how long placing an Order takes, deliberately: releasing a hold out from
 * under a run that is still going is the worse of the two mistakes, because that one oversells,
 * while a hold outliving a dead process only makes stock unsellable for a few minutes.
 *
 * It used to be Core's whole answer, on the argument that no deployment had yet needed to say
 * anything different. ADR-0070 is a deployment needing to: a hold now spans a Shopper walking
 * into their banking app, and how long that takes is a fact about a Store's Shoppers and their
 * banks that Core cannot know. So it is a *default* now rather than the rule — a deployment
 * sets its own as {@link ReservationsOptions.holdWindowMs}, and one that says nothing gets
 * exactly this (ADR-0075).
 */
export const DEFAULT_RESERVATION_HOLD_WINDOW_MS = 15 * 60 * 1000;

/**
 * The shortest hold window a Project may set — a minute, and the reason is that a hold has to
 * outlive the placement that took it.
 *
 * Everything between `hold-reservations` and `capture-order` happens inside the window,
 * including `take-payment`, which is a round trip into somebody else's system. A window the
 * run overruns is released by the sweeper from under itself, and `consumeReservations` then
 * raises **after the money has moved** — the one failure in this module that costs a Shopper
 * rather than costing the Store a few minutes of unsellable stock.
 *
 * A minute is also the granularity at which a lapsed hold is noticed at all: the sweeper runs
 * on `SWEEP_INTERVAL_MS`, so a window below one sweep asks for a precision nothing acts on.
 *
 * **There is deliberately no ceiling above it.** See {@link ReservationsOptions.holdWindowMs}.
 */
export const MINIMUM_RESERVATION_HOLD_WINDOW_MS = 60 * 1000;

/**
 * What a Project says about its Reservations in `kobai.config.ts` — a subject, not a scalar
 * (ADR-0050).
 *
 * Declared here rather than in `config.ts` because this module owns the number and the rules
 * about it; `config.ts` is the shape of the file, not the authority on what a hold is.
 */
export type ReservationsOptions = {
  /**
   * **How long a hold stands before the sweeper may give it back.** Defaults to fifteen
   * minutes.
   *
   * At least {@link MINIMUM_RESERVATION_HOLD_WINDOW_MS}, as a whole number of milliseconds. A
   * value below that stops the boot rather than being clamped to fit — see
   * {@link resolveHoldWindowMs}.
   *
   * ```ts
   * reservations: { holdWindowMs: 30 * 60 * 1000 }
   * ```
   *
   * **Core keeps a floor and no ceiling, and that asymmetry with `session.idleWindowMs` is a
   * decision rather than an omission** (ADR-0075). ADR-0050 caps an idle window because that
   * window is *renewed by traffic*, so it bounds an abandoned browser and nothing at all a
   * thief who keeps clicking — the cap is the only bound left. Nothing renews a hold: it is
   * written once with a deadline and the sweeper gives it back at that deadline, so the window
   * **is** the bound and there is no gap above it for a ceiling to fill. What a long one costs
   * is the Store's own stock left unsellable after a Shopper walked away, which is this
   * deployment's inventory, this deployment's Shoppers and this deployment's money — and how
   * long a Shopper takes in a banking app is precisely the fact ADR-0070 says Core cannot know.
   * A ceiling would be Core guessing at the one number it has just admitted it cannot guess.
   *
   * So set this as long as your Shoppers' banks need. A ceiling stays addable later at no cost
   * to a Project under it; a deployment that wants one today enforces it where it builds this
   * config, which is a line of its own code rather than an argument with Core.
   */
  readonly holdWindowMs?: number;
};

/**
 * Turns what a Project wrote into the window this module writes onto a hold, or **stops the
 * boot**.
 *
 * Called by `createKobai` before anything is opened, so an unusable window is a process that
 * never serves rather than one holding stock for a length nobody chose. Throwing is right where
 * a failed migration returns an outcome (#2): a migration fails for reasons a running
 * deployment can meet, whereas this is a value in a file a Developer just wrote, wrong on every
 * boot until it is fixed. The message names the key, the value it was given and the bound it
 * missed, because "invalid configuration" is not a diagnosis.
 *
 * **Nothing is clamped**, for ADR-0050's reason: a deployment whose holds quietly last
 * something other than what its config file says is a bug found by a Shopper who paid at their
 * bank and came back to `insufficient-stock`.
 */
export function resolveHoldWindowMs(options?: ReservationsOptions): number {
  /** Where a Developer has to go to fix it, spelled the way they wrote it. */
  const HOLD_WINDOW_SETTING = "`reservations.holdWindowMs` in kobai.config.ts";

  const holdWindowMs = options?.holdWindowMs;
  if (holdWindowMs === undefined) return DEFAULT_RESERVATION_HOLD_WINDOW_MS;

  if (!Number.isSafeInteger(holdWindowMs)) {
    throw new Error(
      `${HOLD_WINDOW_SETTING} must be a whole number of milliseconds, and is ${holdWindowMs}.`,
    );
  }
  if (holdWindowMs < MINIMUM_RESERVATION_HOLD_WINDOW_MS) {
    throw new Error(
      `${HOLD_WINDOW_SETTING} must be at least ${MINIMUM_RESERVATION_HOLD_WINDOW_MS} (one minute), and is ${holdWindowMs}. A hold has to outlive the placement that took it — taking payment happens inside the window — and the sweeper only notices a lapsed one once a minute, so a window shorter than this is one a placement can overrun before the Order is written.`,
    );
  }

  // No upper bound, deliberately, and not for want of asking: how long a hold should stand is
  // a fact about this Store's Shoppers that Core cannot know (ADR-0075).
  return holdWindowMs;
}

/**
 * A Reservation as its holder carries it — the claim, plus the row that authorises undoing it.
 *
 * The claim and nothing restated: a held Reservation *is* a {@link ReservationClaim} that has been
 * written down, so it is spelled that way rather than as four fields that would have to be kept in
 * step with the three the provider sees.
 */
export type HeldReservation = ReservationClaim & { readonly id: string };

/** Holding either claims everything asked for, or claims nothing and says which provider said no. */
export type HoldResult =
  | {
      readonly ok: true;
      /**
       * Everything this Cart is holding now — what it already held and this call adopted, plus
       * whatever this call had to claim.
       *
       * This is what `capture-order` consumes, so it is the whole hold rather than this call's
       * share of it.
       */
      readonly reservations: readonly HeldReservation[];
      /**
       * The ones **this call** claimed, and the only ones its caller may ever release.
       *
       * Releasing an adopted hold would take stock away from a Cart that still owns it, which is
       * the failure ADR-0070's whole design exists to prevent: the storefront held before it sent
       * the Shopper to their bank, a placement adopted that hold and was then refused, and its
       * compensation would have given away the units the Shopper had already paid for. Empty
       * when everything asked for was already held.
       */
      readonly claimed: readonly HeldReservation[];
      /**
       * When this hold lapses — the earliest deadline among the Reservations, since that is the
       * moment it stops covering the Cart.
       *
       * `undefined` when nothing is held at all, which is a Cart of Variants nothing is counting:
       * there is no deadline to report because there is nothing to lose (ADR-0014).
       */
      readonly expiresAt: Date | undefined;
    }
  | {
      readonly ok: false;
      readonly reason: ReservationRefusal;
      readonly detail: string;
    };

/**
 * Holds a Reservation for every scarce thing these lines claim — **or adopts the hold this Cart
 * already has** (ADR-0070).
 *
 * All of it or none of it, in one transaction: a Cart holding the last poster and the last mug
 * must not take the poster and then refuse, because the Shopper is told no either way and the
 * poster would be unsellable until the sweeper noticed. The transaction is also what makes each
 * provider's atomic claim and Core's record of it a single fact — a row saying units are held
 * that were not, or units held with no row to release them by, are the two failures this shape
 * removes.
 *
 * **There are two callers now, and this is the whole of what they share.** A storefront holds a
 * Cart's stock before sending a Shopper to their bank (`POST /store/carts/{id}/reservations`),
 * and `hold-reservations` claims inside `place-order` as it always has. The second one must not
 * take a *second* hold on a Cart the first already holds — that would claim the units twice and
 * make a Store unable to sell stock it has — so this function is claim-**or**-adopt, and which
 * of the two happened is reported as {@link HoldResult.claimed} rather than left to be inferred.
 *
 * **What is adopted is a hold that matches these claims exactly, and nothing else is touched.**
 * A Cart with no such hold is claimed for exactly as before, which is what keeps a storefront
 * that never holds unaffected. Two decisions are folded into that sentence and both are about
 * what *not* to do with a hold that no longer fits the Cart — a line added, a quantity changed,
 * a window that lapsed while the Shopper was at their bank:
 *
 * - **A partial hold is not adopted**, because `capture-order` consumes the Reservations it is
 *   handed and nothing else: a Cart that grew a line after holding would have that line captured
 *   against no claim at all, which is the overselling this file exists to prevent. A hold
 *   *larger* than the Cart is refused adoption for the mirror reason — it would consume units for
 *   goods nobody bought.
 * - **A hold that does not fit is left standing rather than released.** It is tempting to give it
 *   back and take a fresh one in the same transaction, and it is wrong: a placement that adopted
 *   that hold may be between `take-payment` and `capture-order` right now, and releasing its rows
 *   would make Capture raise **after the money moved** — the exact failure ADR-0070 exists to
 *   prevent, arriving through the release path instead of through a compensation. **Nothing here
 *   releases a Reservation.** The stale hold lapses and the sweeper gives it back, which costs a
 *   Store some stock it cannot sell for the length of one window and costs nobody their money.
 *
 * The consequence to know about is that a Cart changed after it was held holds its old claim and
 * its new one at once, so a Store with barely enough may refuse the second — and that a hold
 * asked for a *third* time is adopted again rather than claimed again, because the matching
 * subset of what the Cart holds is what adoption looks for.
 *
 * **The window is passed in rather than read from the constant**, because it belongs to the
 * deployment rather than to this module (ADR-0075) — and required rather than defaulted, so a
 * caller that forgot it is a compile error instead of a second answer to how long this Store
 * holds stock.
 */
export async function holdReservations(
  db: Database,
  cartId: string,
  lines: readonly ReservableLine[],
  holdWindowMs: number,
): Promise<HoldResult> {
  const expiresAt = new Date(Date.now() + holdWindowMs);

  try {
    return await db.transaction(async (tx: Transaction): Promise<HoldResult> => {
      // Before the read, and for the length of the transaction: see CART_HOLD_LOCK_NAMESPACE.
      await tx.execute(
        sql`select pg_advisory_xact_lock(${CART_HOLD_LOCK_NAMESPACE}, hashtext(${cartId}))`,
      );

      const claims: ReservationClaim[] = [];
      // In series rather than in parallel: two providers claiming at once inside one
      // transaction would be two statements on one connection, and the first refusal should
      // stop the second provider from claiming anything at all.
      for (const provider of RESERVATION_PROVIDERS) {
        claims.push(...(await provider.claimsFor(tx, lines)));
      }

      // Already holding exactly this, so hold it again rather than twice. The deadline is not
      // pushed out: a hold that renewed itself on every request would let a storefront keep a
      // Store's stock indefinitely by retrying, and how long one stands is the deployment's
      // decision rather than the caller's (ADR-0075).
      const adopted = adoptable(await liveHoldOn(tx, cartId), claims);
      if (adopted) {
        return {
          ok: true,
          reservations: held(adopted),
          claimed: [],
          expiresAt: soonest(adopted),
        };
      }

      if (claims.length === 0) {
        return { ok: true, reservations: [], claimed: [], expiresAt: undefined };
      }

      for (const [name, group] of byProvider(claims)) {
        const outcome = await providerNamed(name).hold(tx, group);
        // Thrown rather than returned, because returning would commit what the providers
        // before this one had already claimed. Caught immediately below, where the refusal
        // becomes the answer.
        if (!outcome.ok) throw new HoldRefused(outcome.reason, outcome.detail);
      }

      const rows = await tx
        .insert(reservation)
        .values(claims.map((claim) => ({ ...claim, cartId, expiresAt })))
        .returning({
          id: reservation.id,
          provider: reservation.provider,
          subject: reservation.subject,
          quantity: reservation.quantity,
        });

      return { ok: true, reservations: rows, claimed: rows, expiresAt };
    });
  } catch (cause) {
    if (cause instanceof HoldRefused) {
      return { ok: false, reason: cause.reason, detail: cause.detail };
    }
    throw cause;
  }
}

/**
 * The advisory-lock namespace every hold on a Cart serialises in, per Cart.
 *
 * Arbitrary but fixed, exactly as `createFirstMerchant`'s and `updateRole`'s are, and held for
 * the length of the transaction however that transaction ends. It is the **two-argument** form —
 * this namespace and `hashtext(cart_id)` — so two Carts never wait for each other: a
 * deployment-wide lock would put every placement in a queue behind every other one, for a
 * question that is only ever about one Cart. Postgres keeps the two-argument locks apart from
 * the one-argument ones, so this cannot collide with either key above.
 *
 * **A conditional update cannot do this job**, which is the same departure from ADR-0018's usual
 * answer that the last-administrator guard makes. Inventory claims a scarce thing with
 * `update … where on_hand - reserved >= n` because the condition is about *the row being
 * written*, so Postgres takes the row lock before evaluating it and the loser re-evaluates
 * against what the winner left. Claim-or-adopt's condition is about **other rows** — is this
 * Cart holding a Reservation already — and a `select` reads those without locking them, so two
 * storefront retries arriving together each see no hold and each claim one. The lock is taken
 * before the read, so the second transaction re-reads a database the first has already changed
 * and adopts what it finds. `the-cart-that-held-twice.test.ts` is the assertion, and it has been
 * watched failing with this line removed.
 *
 * **A collision on `hashtext` costs nothing but a wait.** Two Carts whose identifiers hash alike
 * serialise their holds against each other, which is correctness with a moment of contention
 * rather than a wrong answer — the lock decides who reads first and never what they read.
 */
const CART_HOLD_LOCK_NAMESPACE = 411_305_003;

/** One row of the hold a Cart is carrying, as this module reads it back. */
type LiveReservation = HeldReservation & { readonly expiresAt: Date };

/**
 * What this Cart is holding right now — held, unconsumed, unreleased, and not yet lapsed.
 *
 * **A lapsed hold is not a live one**, even though the sweeper has not reached it yet: adopting
 * a Reservation whose window has passed would hand a Shopper a hold the next sweep is about to
 * take away, which is the one failure `expires_at` exists to prevent. It is re-held instead,
 * which gives the units back and takes them again in the same transaction.
 */
async function liveHoldOn(
  tx: Transaction,
  cartId: string,
): Promise<readonly LiveReservation[]> {
  return tx
    .select({
      id: reservation.id,
      provider: reservation.provider,
      subject: reservation.subject,
      quantity: reservation.quantity,
      expiresAt: reservation.expiresAt,
    })
    .from(reservation)
    .where(
      and(
        eq(reservation.cartId, cartId),
        isNull(reservation.consumedAt),
        isNull(reservation.releasedAt),
        // Postgres's clock rather than this process's, exactly as the sweeper compares it: a
        // hold this process thinks is live and the sweeper thinks is lapsed is the disagreement
        // that oversells.
        gt(reservation.expiresAt, sql`now()`),
      ),
    );
}

/** The hold, as everything downstream of it carries a Reservation. */
function held(live: readonly LiveReservation[]): readonly HeldReservation[] {
  return live.map(({ id, provider, subject, quantity }) => ({
    id,
    provider,
    subject,
    quantity,
  }));
}

/**
 * The Reservations this Cart is holding that **are** these claims, one for one — or nothing,
 * meaning there is no hold here to adopt.
 *
 * A **subset** rather than the whole of what the Cart holds, and each claim matched *exactly*
 * rather than generously. Both halves are decisions:
 *
 * - **Exactly**, in both directions. A row holding fewer units than the claim is short for the
 *   obvious reason; one holding more cannot be adopted either, because `capture-order` consumes
 *   every Reservation it is handed — so a Cart that dropped a line and adopted its older, larger
 *   hold would take units off the shelf for goods nobody bought.
 * - **A subset**, so that a Cart which changed after it was held, and therefore claimed afresh,
 *   is *adopted* the next time it asks rather than claiming a third time. Its stale rows are
 *   left out of the answer and out of the way; the sweeper is what ends them.
 *
 * An empty set of claims is adopted by every hold, including no hold at all: a Cart of Variants
 * nothing is counting has nothing to hold and nothing to look for.
 */
function adoptable(
  live: readonly LiveReservation[],
  claims: readonly ReservationClaim[],
): readonly LiveReservation[] | undefined {
  const spare = [...live];
  const adopted: LiveReservation[] = [];

  for (const claim of claims) {
    const at = spare.findIndex(
      (row) =>
        row.provider === claim.provider &&
        row.subject === claim.subject &&
        row.quantity === claim.quantity,
    );
    // One of this Cart's claims is unheld, so there is no hold here that covers it, and the
    // whole of what the Cart claims is taken afresh instead.
    if (at === -1) return undefined;

    const [row] = spare.splice(at, 1);
    if (row) adopted.push(row);
  }

  return adopted;
}

/**
 * The earliest deadline in a hold — when it stops covering the Cart entire.
 *
 * They are written together and so agree today; reporting the earliest is what keeps that an
 * implementation detail rather than something a caller would have to know.
 */
function soonest(live: readonly LiveReservation[]): Date | undefined {
  return live
    .map((row) => row.expiresAt)
    .reduce<Date | undefined>(
      (earliest, at) => (earliest === undefined || at < earliest ? at : earliest),
      undefined,
    );
}

/**
 * Takes these Reservations for good, **inside the transaction the Order is written in**.
 *
 * That is ADR-0018's other half and the reason `hold-reservations` sits where it does: stock and
 * Orders cannot disagree if neither can be written without the other, so consuming needs no
 * compensation — the database unwinds it along with the Order.
 *
 * A Reservation that is no longer held raises rather than being skipped. The only way to reach
 * that is a run that outlived its own hold window, which is a deployment placing Orders more
 * slowly than {@link ReservationsOptions.holdWindowMs} allows; consuming anyway would sell
 * units the Store has already offered to somebody else. It travels as a bug rather than as a
 * refusal for
 * the same reason a fraction of a penny does — the request was fine, and what is wrong is this
 * deployment.
 */
export async function consumeReservations(
  tx: Transaction,
  held: readonly HeldReservation[],
  orderId: string,
): Promise<void> {
  if (held.length === 0) return;

  const taken = await tx
    .update(reservation)
    .set({ consumedAt: sql`now()`, orderId })
    .where(
      and(
        inArray(
          reservation.id,
          held.map((row) => row.id),
        ),
        isNull(reservation.consumedAt),
        isNull(reservation.releasedAt),
      ),
    )
    .returning({
      id: reservation.id,
      provider: reservation.provider,
      subject: reservation.subject,
      quantity: reservation.quantity,
    });

  if (taken.length !== held.length) {
    throw new Error(
      // The key rather than the number, deliberately. This runs inside the Capture transaction
      // and is handed no window, and a message quoting Core's fifteen minutes to a deployment
      // that configured forty-five would send a Developer looking for a bug in the wrong place
      // — worse than a message that names where the number lives and lets them read it.
      `${held.length - taken.length} of this Order's Reservations were no longer held when it was captured, so the stock they claimed could not be consumed. This placement outlived its own hold window — \`reservations.holdWindowMs\` in kobai.config.ts, or Core's default if that says nothing.`,
    );
  }

  for (const [name, group] of byProvider(taken)) {
    await providerNamed(name).consume(tx, group);
  }
}

/**
 * Gives these Reservations back — what `hold-reservations`' compensation does when a later Step
 * fails.
 *
 * Idempotent by construction: the `update` claims the rows it is about to release and reports
 * which ones it actually claimed, so a Reservation the sweeper released a moment earlier is
 * simply not among them and its units are not returned twice.
 */
export async function releaseReservations(
  db: Database,
  held: readonly HeldReservation[],
): Promise<number> {
  if (held.length === 0) return 0;

  return db.transaction(async (tx: Transaction) => {
    const released = await releasing(
      tx,
      inArray(
        reservation.id,
        held.map((row) => row.id),
      ),
    );
    return released.length;
  });
}

/**
 * Releases every hold whose window has lapsed — the sweeper, on a plain interval (ADR-0026 is
 * deliberately not involved).
 *
 * `now()` is Postgres's rather than this process's, so a clock that has drifted on the machine
 * running the sweep cannot release a hold that has not lapsed. Everything lapsed goes in one
 * statement: the rows are few, and a batch that left some behind would need a second pass
 * anyway.
 */
export async function releaseLapsedReservations(db: Database): Promise<number> {
  return db.transaction(async (tx: Transaction) => {
    const released = await releasing(tx, lt(reservation.expiresAt, sql`now()`));
    return released.length;
  });
}

/**
 * The release both paths share: claim the rows, then hand each provider back what those rows
 * say it claimed.
 *
 * The order is the whole of it. Claiming first means only one caller can ever be the one that
 * releases a given Reservation, whether the other is a compensation, the sweeper, or a second
 * sweeper on another instance of the application.
 */
async function releasing(tx: Transaction, which: SQL) {
  const released = await tx
    .update(reservation)
    .set({ releasedAt: sql`now()` })
    .where(and(which, isNull(reservation.consumedAt), isNull(reservation.releasedAt)))
    .returning({
      provider: reservation.provider,
      subject: reservation.subject,
      quantity: reservation.quantity,
    });

  for (const [name, group] of byProvider(released)) {
    await providerNamed(name).release(tx, group);
  }

  return released;
}

/** The claims each provider made, so each is asked once with everything that is its own. */
function byProvider(
  claims: readonly ReservationClaim[],
): Map<string, ReservationClaim[]> {
  const grouped = new Map<string, ReservationClaim[]>();
  for (const claim of claims) {
    const existing = grouped.get(claim.provider);
    if (existing) existing.push(claim);
    else grouped.set(claim.provider, [claim]);
  }
  return grouped;
}

/**
 * The provider a row names, or a failure saying so.
 *
 * A `core_reservation` naming a provider this build does not have is a database written by a
 * newer kobai than the one reading it — a downgrade. Refusing loudly is the only honest answer:
 * the units are claimed by something whose arithmetic this build cannot undo, and quietly
 * skipping the row would leak stock for as long as the downgrade lasted.
 */
function providerNamed(name: string): ReservationProvider {
  const provider = RESERVATION_PROVIDERS.find((candidate) => candidate.name === name);
  if (!provider) {
    throw new Error(
      `A Reservation names the provider ${JSON.stringify(name)}, which this build of kobai does not have. Its claim cannot be held, consumed or released here.`,
    );
  }
  return provider;
}

/** A provider refusing, on its way out of the transaction that would otherwise commit. */
class HoldRefused extends Error {
  readonly reason: ReservationRefusal;
  readonly detail: string;

  constructor(reason: ReservationRefusal, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "HoldRefused";
    this.reason = reason;
    this.detail = detail;
  }
}
