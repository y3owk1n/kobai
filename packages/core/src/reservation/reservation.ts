import { and, inArray, isNull, lt, type SQL, sql } from "drizzle-orm";
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
 * How long a hold stands before the sweeper may give it back.
 *
 * Generous against how long placing an Order takes, deliberately: releasing a hold out from
 * under a run that is still going is the worse of the two mistakes, because that one oversells,
 * while a hold outliving a dead process only makes stock unsellable for a few minutes. It is a
 * Core constant rather than a `kobai.config.ts` key because no deployment has yet needed to say
 * anything different, and a key is a promise (ADR-0050).
 */
export const RESERVATION_HOLD_WINDOW_MS = 15 * 60 * 1000;

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
  | { readonly ok: true; readonly reservations: readonly HeldReservation[] }
  | {
      readonly ok: false;
      readonly reason: ReservationRefusal;
      readonly detail: string;
    };

/**
 * Holds a Reservation for every scarce thing these lines claim.
 *
 * All of it or none of it, in one transaction: a Cart holding the last poster and the last mug
 * must not take the poster and then refuse, because the Shopper is told no either way and the
 * poster would be unsellable until the sweeper noticed. The transaction is also what makes each
 * provider's atomic claim and Core's record of it a single fact — a row saying units are held
 * that were not, or units held with no row to release them by, are the two failures this shape
 * removes.
 */
export async function holdReservations(
  db: Database,
  lines: readonly ReservableLine[],
): Promise<HoldResult> {
  const expiresAt = new Date(Date.now() + RESERVATION_HOLD_WINDOW_MS);

  try {
    return await db.transaction(async (tx: Transaction): Promise<HoldResult> => {
      const claims: ReservationClaim[] = [];
      // In series rather than in parallel: two providers claiming at once inside one
      // transaction would be two statements on one connection, and the first refusal should
      // stop the second provider from claiming anything at all.
      for (const provider of RESERVATION_PROVIDERS) {
        claims.push(...(await provider.claimsFor(tx, lines)));
      }
      if (claims.length === 0) return { ok: true, reservations: [] };

      for (const [name, group] of byProvider(claims)) {
        const outcome = await providerNamed(name).hold(tx, group);
        // Thrown rather than returned, because returning would commit what the providers
        // before this one had already claimed. Caught immediately below, where the refusal
        // becomes the answer.
        if (!outcome.ok) throw new HoldRefused(outcome.reason, outcome.detail);
      }

      const rows = await tx
        .insert(reservation)
        .values(claims.map((claim) => ({ ...claim, expiresAt })))
        .returning({
          id: reservation.id,
          provider: reservation.provider,
          subject: reservation.subject,
          quantity: reservation.quantity,
        });

      return { ok: true, reservations: rows };
    });
  } catch (cause) {
    if (cause instanceof HoldRefused) {
      return { ok: false, reason: cause.reason, detail: cause.detail };
    }
    throw cause;
  }
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
 * slowly than {@link RESERVATION_HOLD_WINDOW_MS} allows; consuming anyway would sell units the
 * Store has already offered to somebody else. It travels as a bug rather than as a refusal for
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
      `${held.length - taken.length} of this Order's Reservations were no longer held when it was captured, so the stock they claimed could not be consumed. A hold lapses after ${RESERVATION_HOLD_WINDOW_MS}ms, and this placement took longer than that.`,
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
