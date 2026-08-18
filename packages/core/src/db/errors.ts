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

/** And for a `check` constraint refusing a value — how Inventory refuses to go negative. */
const CHECK_VIOLATION = "23514";

/** And for a foreign key refusing a delete — how a Role held by Merchants refuses to go. */
const FOREIGN_KEY_VIOLATION = "23503";

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
  return violates(cause, UNIQUE_VIOLATION, index);
}

/**
 * Whether this is Postgres refusing a write against the named `check` constraint.
 *
 * The same reading as above, for the other half of the same idea: a constraint is where a rule
 * lives when Core does not mediate every writer (ADR-0004), and `core_inventory`'s are what stop
 * stock going negative or being reserved beyond what the Store has. A Merchant counting a shelf
 * below what is already claimed is an ordinary conflict, so it is read here and answered rather
 * than travelling as a broken server.
 */
export function violatesCheckConstraint(cause: unknown, constraint: string): boolean {
  return violates(cause, CHECK_VIOLATION, constraint);
}

/**
 * Whether this is Postgres refusing a delete because the named foreign key still points at the
 * row — how `deleteRole` learns that Merchants hold the Role it was asked to remove.
 *
 * Read rather than asked for in advance, for the reason the unique index above is: a `select`
 * for the referencing rows followed by a `delete` lets a request in between create one, and the
 * key would then refuse what the read had already promised was safe. `on delete restrict` makes
 * the key the check, and this is how its answer is read.
 */
export function violatesForeignKey(cause: unknown, key: string): boolean {
  return violates(cause, FOREIGN_KEY_VIOLATION, key);
}

/**
 * The walk all three of them do, because the driver's error does not arrive bare: Drizzle wraps it in
 * a `DrizzleQueryError` carrying the query, and a caller may wrap it again. Matching the
 * constraint by name as well as by code is what keeps each one narrow — a second constraint on
 * the same table must not be mistaken for the one being claimed against.
 */
function violates(cause: unknown, sqlstate: string, constraint: string): boolean {
  let error: unknown = cause;

  for (let depth = 0; depth < DEEPEST_CAUSE; depth++) {
    if (error === null || typeof error !== "object") return false;

    const failure = error as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (failure.code === sqlstate && failure.constraint === constraint) return true;
    error = failure.cause;
  }

  return false;
}
