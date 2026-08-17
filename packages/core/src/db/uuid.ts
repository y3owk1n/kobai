const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a path parameter could name a row at all.
 *
 * Postgres raises on a malformed uuid, and an unhandled raise is a 500 — which would report
 * a broken server for what is only a request for something that does not exist.
 *
 * It sits beside the database rather than inside one module's read path because every table
 * Core owns is keyed this way, and the second caller in a different area of the code is what
 * moved it here.
 */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
