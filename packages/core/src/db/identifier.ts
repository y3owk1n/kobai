/**
 * Wraps a SQL identifier in double quotes, escaping any it contains.
 *
 * kobai builds very little SQL by hand — migration tracking locations and, in the test
 * harness, throwaway database names. Those are the places a value reaches SQL somewhere a
 * bound parameter cannot go, so they go through here.
 */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
