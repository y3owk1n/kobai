import type { CatalogRefusal } from "@kobai/client";

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
 *
 * **This is the documented answer for three cases, and the third is a decision rather than an
 * omission** (ADR-0063). A 500 is the first: it carries no `reason` at all, deliberately,
 * because a stack trace is not a caller's business. The second is anything that is not a kobai
 * refusal — the network being gone. The third is `PriceRefusal` and `PlaceOrderRefusal`, the
 * two families whose `reason` is an **open string**: a Step of a Project's or a Plugin's own is
 * Extension Point 2 and may refuse with a word Core has never heard of, so closing those sets
 * would close that Extension Point (ADR-0060). There is nothing there to narrow, and a `switch`
 * over them could never be exhaustive, so they take the prose — by design, and not because
 * somebody forgot to write the `Record` for them.
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

/**
 * A refusal, thrown.
 *
 * TanStack Query decides a query failed by a promise rejecting, and `@kobai/client` reports a
 * refusal by *resolving* with `{ error }` — so every call in this Admin ends in `orThrow`,
 * which turns the second into the first without losing the body. The body is what carries the
 * `reason`, so it travels rather than being flattened into a string here: a screen that
 * branches needs the word, and a screen that only reports needs the prose, and both are in
 * there.
 */
export class Refused extends Error {
  readonly body: unknown;

  constructor(body: unknown) {
    super(messageOf(body, "kobai refused the request."));
    this.name = "Refused";
    this.body = body;
  }
}

/**
 * A `@kobai/client` result, as a value or a rejection.
 *
 * `data` is `undefined` on a 204 as well as on a refusal, so the two are told apart by
 * `error` rather than by the absence of a body — otherwise revoking something would report
 * a failure every time it worked.
 */
export function orThrow<T>(result: { data?: T; error?: unknown }): T {
  if (result.error !== undefined) throw new Refused(result.error);
  return result.data as T;
}

/**
 * What to show a Merchant when a call did not work, refusal or not.
 *
 * A rejection that is not a {@link Refused} is the network failing, or the process being
 * gone — neither of which kobai has words for, and neither of which a Merchant can act on
 * differently — so both take the caller's fallback rather than `TypeError: Failed to fetch`.
 */
export function problemOf(thrown: unknown, fallback: string): string {
  if (thrown instanceof Refused) return messageOf(thrown.body, fallback);
  return fallback;
}

/**
 * A refusal's `reason`, if it is one this closed family declares.
 *
 * The `known` argument is a `Record` keyed by the family's own union, which is what makes it
 * complete: a reason added to that family in Core has no key, the `Record` does not compile,
 * and the Admin's build goes red in the same commit (ADR-0063). This function is where the
 * type becomes a runtime membership test, and there is one of it — `lib/kobai.ts` asks the
 * same question of the admin gate's four reasons.
 */
export function knownReasonOf<R extends string>(
  refusal: unknown,
  known: Record<R, true>,
): R | undefined {
  const reason = reasonOf(refusal);
  if (reason === undefined) return undefined;
  return Object.hasOwn(known, reason) ? (reason as R) : undefined;
}

/**
 * Every `reason` a catalog operation can be refused with, as a value rather than a type.
 *
 * `@kobai/client` is types only, so a runtime membership test needs a list — and a list
 * written by hand is one that quietly falls behind the API. This is a `Record` keyed by the
 * union rather than an array for exactly that reason: **a reason added to `CatalogRefusal`
 * has no key here and does not compile**, and a key that is not one of kobai's does not
 * compile either. That is ADR-0063's "an addition to a closed family reddens the Admin's
 * build in the same commit", at the one place the closed set becomes a value.
 *
 * It maps to `true` and not to prose. A table of messages was considered and rejected in
 * ADR-0063: it decouples the words from the route that can produce them, so it goes stale
 * silently, and it defeats the exhaustiveness by making every reason equally reachable from
 * everywhere. **The words belong at the screen**, in a `switch` over this union that the
 * compiler holds to covering all of it.
 */
const CATALOG_REASONS: Record<CatalogRefusal["reason"], true> = {
  invalid: true,
  "malformed-body": true,
  "product-not-found": true,
  "variant-not-found": true,
  "price-not-found": true,
  "sku-taken": true,
  "last-variant": true,
  "stock-is-reserved": true,
  "unsupported-currency": true,
  "unknown-fulfilment-strategy": true,
};

/**
 * Which catalog refusal this was, for a screen that has something better to say than the
 * prose kobai sent.
 *
 * `undefined` for a 500, for a refusal from some other family, and for a rejection that is
 * not a refusal at all — so the screen's `switch` has one arm for "kobai did not say" and
 * arms for each thing it can say, and the compiler counts them.
 */
export function catalogReasonOf(thrown: unknown): CatalogRefusal["reason"] | undefined {
  if (!(thrown instanceof Refused)) return undefined;
  return knownReasonOf(thrown.body, CATALOG_REASONS);
}
