import type { Logger } from "./config.ts";
import type { Database } from "./db/client.ts";
import { deleteExpiredIdempotencyKeys } from "./order/idempotency.ts";
import { releaseLapsedReservations } from "./reservation/reservation.ts";

/**
 * **The sweep** — everything kobai does on a timer, which is deliberately one small thing
 * (ADR-0057, amending part of ADR-0026).
 *
 * The Reservation sweeper is what it exists for: a hold whose window has lapsed has to be given
 * back, or a process that died mid-placement would keep stock unsellable forever (ADR-0027). A
 * job queue brings retry, visibility and failure semantics of its own and deserves its own spec;
 * this is one statement on an interval, and a run that is missed is a run that happens a minute
 * later. The accepted cost is recorded in #98: this is kobai's first background work outside the
 * job mechanism, and the queue spec will have to migrate it.
 *
 * **The idempotency keys are swept here because this is where the timer is.** Nothing deleted
 * them before — #102 wrote the note into `db/schema.ts` saying so — and they are the same shape
 * of work: a row that has stopped binding, deleted by one `delete … where expires_at < now()`.
 * Putting them on a second timer would be a second answer to "what does kobai do periodically".
 */

/** What one sweep did, so that a caller can log it or a test can assert on it. */
export type SweepOutcome = {
  /** Holds whose window had lapsed, released back to the provider that owns them. */
  readonly reservationsReleased: number;
  /** Idempotency keys that had stopped binding, deleted. */
  readonly idempotencyKeysDeleted: number;
};

export type SweeperOptions = {
  /**
   * How often to sweep. A minute by default, which is short against a fifteen-minute hold and
   * long against a placement — the window a lapsed hold sits in before it is noticed is the
   * only thing this decides.
   */
  readonly intervalMs?: number;
};

/** A minute. Nothing here is urgent; a hold lapsed a minute ago has already been lapsed a while. */
export const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Releases every lapsed hold and deletes every expired idempotency key, once.
 *
 * Two statements rather than one transaction, because they are two independent facts about two
 * tables: a failure to delete a stale key must not leave stock claimed, and neither has anything
 * to say about the other's consistency.
 */
export async function sweepExpired(db: Database): Promise<SweepOutcome> {
  return {
    reservationsReleased: await releaseLapsedReservations(db),
    idempotencyKeysDeleted: await deleteExpiredIdempotencyKeys(db),
  };
}

/**
 * Starts the interval, and hands back the way to stop it.
 *
 * Three properties are deliberate and each one is a bug that would otherwise be waiting:
 *
 * - **It never overlaps itself.** A sweep still running when the next tick arrives skips that
 *   tick rather than starting a second one, so a slow database produces a slower sweep instead of
 *   a growing pile of concurrent ones.
 * - **A failure is logged, not thrown.** This runs on a timer with nobody to catch it, and an
 *   unhandled rejection takes a Node process down — a Store that stopped serving because it could
 *   not tidy up would be a far worse failure than the untidiness.
 * - **The timer is unref'd**, so it never holds a process open. A command that has finished its
 *   work should exit, and a sweeper is not work worth waiting for.
 */
export function startSweeper(
  db: Database,
  logger: Logger,
  options?: SweeperOptions,
): () => void {
  let sweeping = false;

  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;

    void sweepExpired(db)
      .then((outcome) => {
        // Silent when there was nothing to do, which is almost every tick. A log line a minute
        // saying "0, 0" is a log nobody reads, and therefore a log that hides the one that
        // mattered.
        if (outcome.reservationsReleased > 0 || outcome.idempotencyKeysDeleted > 0) {
          logger.info("swept", { ...outcome });
        }
      })
      .catch((cause: unknown) => {
        logger.error("the sweep failed", {
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      })
      .finally(() => {
        sweeping = false;
      });
  }, options?.intervalMs ?? SWEEP_INTERVAL_MS);

  timer.unref?.();

  return () => clearInterval(timer);
}
