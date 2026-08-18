/**
 * Reading what Postgres refused, when the refusal is the mechanism rather than an accident.
 *
 * A unique index is how kobai claims something that only one caller may have — one Line Item
 * per Variant on a Cart, one Order per Cart — because the check and the claim are then a single
 * operation and two simultaneous callers cannot both pass the check (ADR-0018). The cost of
 * that is that the *loser* finds out by being thrown at, so the error has to be read rather
 * than merely propagated: a constraint violation reaching a storefront as a 500 would be the
 * rule holding by accident and reporting a broken server for an ordinary race.
 */

/** Postgres's SQLSTATE for a unique violation. Every one of them arrives under this code. */
const UNIQUE_VIOLATION = "23505";

/**
 * How far down a `cause` chain to look, so that a cycle cannot become a hung request.
 *
 * Nothing in kobai wraps an error more than twice, and an error whose `cause` is itself is a bug
 * somewhere else — but this walk runs on the failure path of a Capture, where hanging is the
 * worst of the available behaviours. Past the limit the answer is "not this constraint", which
 * lets the original error travel as itself.
 */
const DEEPEST_CAUSE = 16;

/**
 * Whether this is Postgres refusing a write against the named unique index.
 *
 * The whole `cause` chain is walked because the driver's error does not arrive bare: Drizzle
 * wraps it in a `DrizzleQueryError` carrying the query, and a caller may wrap it again. Matching
 * the index by name rather than only the code is what keeps this narrow — a second constraint on
 * the same table must not be mistaken for the one being claimed against.
 */
export function violatesUniqueIndex(cause: unknown, index: string): boolean {
  let error: unknown = cause;

  for (let depth = 0; depth < DEEPEST_CAUSE; depth++) {
    if (error === null || typeof error !== "object") return false;

    const { code, constraint } = error as { code?: unknown; constraint?: unknown };
    if (code === UNIQUE_VIOLATION && constraint === index) return true;
    error = (error as { cause?: unknown }).cause;
  }

  return false;
}
