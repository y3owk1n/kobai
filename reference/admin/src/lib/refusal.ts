/**
 * The prose off a kobai refusal, whatever kind it was.
 *
 * Every refusal the API makes is `{ error, reason }` — one shape whether the caller was
 * turned back at the gate, by a schema, or by a handler — except a 500, which deliberately
 * says only `error`. So `error` is the one field always present and always safe to show, and
 * `reason` is for branching, which the screens that branch do on their own.
 *
 * The argument is `unknown` because the generated client hands back a *union* of every
 * refusal a route declares. Narrowing it here rather than at fifteen call sites is the only
 * reason this function exists.
 */
export function messageOf(refusal: unknown, fallback: string): string {
  if (typeof refusal !== "object" || refusal === null) return fallback;
  if (!("error" in refusal) || typeof refusal.error !== "string") return fallback;
  return refusal.error;
}

/**
 * The `reason` off a refusal, for the screens that have to act on which one it was.
 *
 * Undefined for a 500, which carries no `reason` on purpose, and for anything that is not a
 * refusal at all — so a caller comparing it against a known string is asking the right
 * question either way.
 */
export function reasonOf(refusal: unknown): string | undefined {
  if (typeof refusal !== "object" || refusal === null) return undefined;
  if (!("reason" in refusal) || typeof refusal.reason !== "string") return undefined;
  return refusal.reason;
}
