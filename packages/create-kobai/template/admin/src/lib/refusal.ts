import type {
  ApiKeyNotFound,
  ApiKeyRefusal,
  CartRefusal,
  CatalogRefusal,
  InvalidCredentials,
  InvalidRequest,
  MerchantRefusal,
  OrderRefusal,
  RoleRefusal,
  StoreRefusal,
} from "@kobai/client";

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
 * A narrower for one closed family, built from that family's own union.
 *
 * Every screen that branches on a refusal asks the same two questions in the same order — was
 * this a {@link Refused} at all, and is its `reason` one this family declares — so the pair is
 * built once per family rather than restated per screen. What this deliberately does not do is
 * collapse the families into one table: each `Record` below is keyed by exactly one union,
 * which is what makes a reason added to *that* union in Core a build failure here (ADR-0063).
 * One table of every reason in the API would compile forever and narrow nothing.
 *
 * `undefined` means "kobai did not say, or did not say something this family knows" — a 500, a
 * refusal from another family, or the network being gone — so the caller's `switch` gets one
 * arm for silence and an arm for each word, and the compiler counts them.
 */
function narrowing<R extends string>(known: Record<R, true>) {
  return (thrown: unknown): R | undefined =>
    thrown instanceof Refused ? knownReasonOf(thrown.body, known) : undefined;
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
  "handle-taken": true,
  "last-variant": true,
  "stock-is-reserved": true,
  "unsupported-currency": true,
  "unknown-fulfilment-strategy": true,
  "variant-options-mismatch": true,
  "media-not-found": true,
};

/**
 * Which catalog refusal this was, for a screen that has something better to say than the
 * prose kobai sent.
 *
 * `undefined` for a 500, for a refusal from some other family, and for a rejection that is
 * not a refusal at all — so the screen's `switch` has one arm for "kobai did not say" and
 * arms for each thing it can say, and the compiler counts them.
 */
export const catalogReasonOf = narrowing(CATALOG_REASONS);

/**
 * The one way reading an Order can be turned back, past the gates above every admin route.
 *
 * A family of one is still written as a `Record` rather than compared against the string:
 * the Order screen that will one day have to tell `order-not-found` from whatever
 * `GET /admin/orders/{id}` grows next should hear it from the compiler, not from a Merchant.
 */
const ORDER_REASONS: Record<OrderRefusal["reason"], true> = {
  "order-not-found": true,
};

/** Which Order refusal this was — today, only that there is no such Order. */
export const orderReasonOf = narrowing(ORDER_REASONS);

/**
 * Every `reason` a Cart operation can be refused with (ADR-0071).
 *
 * **Wider than what this Admin can meet**, and deliberately not trimmed to it. The Cart surface
 * here is read-only — there is no route that changes a Cart, and there must not be one, because
 * releasing a hold by hand takes stock from a Shopper who may be mid-payment at their bank — so
 * the only one of these a screen can actually arrive at is `cart-not-found`. The rest belong to
 * the store surface's Cart writes, and they are keyed here anyway because the `Record` is keyed
 * by the **family**: a reason added to `CartRefusal` in Core has no key, does not compile, and
 * reddens this build in the same commit (ADR-0063). Trimming it to the reachable one would turn
 * that guarantee off.
 */
const CART_REASONS: Record<CartRefusal["reason"], true> = {
  invalid: true,
  "malformed-body": true,
  "secret-key-required": true,
  "cart-not-found": true,
  "cart-expired": true,
  "cart-placed": true,
  "line-item-not-found": true,
  "variant-not-found": true,
  "variant-not-priced": true,
};

/** Which Cart refusal this was, for a screen with something better to say than the prose. */
export const cartReasonOf = narrowing(CART_REASONS);

/**
 * Every `reason` a Role operation can be refused with (#173, ADR-0066).
 *
 * The busiest of the three families this Admin's settings screens touch, and the one carrying
 * the refusal that matters: `last-administrator`, which is kobai declining to leave the
 * deployment with nobody who can administer Merchants. That one is a **lockout** rather than a
 * preference — the first Merchant is seeded only while a deployment holds none, so the way back
 * would be raw SQL — which is why the Role editor says the rule out loud before a Merchant tries
 * it, and this is where the answer is narrowed when they do.
 */
const ROLE_REASONS: Record<RoleRefusal["reason"], true> = {
  invalid: true,
  "malformed-body": true,
  "role-not-found": true,
  "role-name-taken": true,
  "role-in-use": true,
  "last-administrator": true,
};

/** Which Role refusal this was, for a screen with something better to say than the prose. */
export const roleReasonOf = narrowing(ROLE_REASONS);

/**
 * Every `reason` a Merchant operation can be refused with — creating one, and moving one onto
 * another Role (#202).
 *
 * `unknown-role` is the one worth reading twice: a Role is named on the way in **by name**, so
 * this arrives when the Role a colleague was to be created against, or moved onto, has been
 * renamed or deleted since the picker offering it was filled. That is a race rather than a typo,
 * and the sentence for it has to say so.
 *
 * **`last-administrator` is in this family as well as in {@link RoleRefusal}'s**, and it is the
 * same word for the same fact: moving the only Merchant who can administer Merchants onto a Role
 * that cannot is the lockout, reached from the other side. Two screens narrow it, and each says
 * what to do rather than only what happened.
 */
const MERCHANT_REASONS: Record<MerchantRefusal["reason"], true> = {
  invalid: true,
  "malformed-body": true,
  "unknown-role": true,
  "email-taken": true,
  "merchant-not-found": true,
  "last-administrator": true,
};

/** Which refusal a Merchant operation met. */
export const merchantReasonOf = narrowing(MERCHANT_REASONS);

/**
 * Every `reason` changing the Store can be refused with (#172, ADR-0065).
 *
 * `default-currency-is-fixed` is the interesting one and the Store screen is written so that a
 * Merchant cannot reach it: every Price carries the Store's default and no other, so moving the
 * column would reinterpret each amount already stored rather than convert it. The arm exists
 * anyway — the family is closed and the compiler counts the arms, and a refusal that can only
 * arrive from somewhere other than this form still has to be legible when it does.
 */
const STORE_REASONS: Record<StoreRefusal["reason"], true> = {
  invalid: true,
  "malformed-body": true,
  "default-currency-is-fixed": true,
};

/** Which refusal changing the Store met. */
export const storeReasonOf = narrowing(STORE_REASONS);

/**
 * The one way revoking an API key can be turned back.
 *
 * Revoking a key that is already revoked is *not* one of them: the route answers 204, because
 * the state asked for is the state it is in. So this arrives only for a key that was never
 * issued here, or one somebody else revoked and removed between two reads of the list.
 */
const API_KEY_NOT_FOUND_REASONS: Record<ApiKeyNotFound["reason"], true> = {
  "api-key-not-found": true,
};

/** Which of the revoke route's own refusals this was. */
export const apiKeyNotFoundReasonOf = narrowing(API_KEY_NOT_FOUND_REASONS);

/**
 * Why the **store** gate turned a request back — the storefront half of `lib/kobai.ts`'s four.
 *
 * `/store` sits behind a bearer API key rather than a Merchant session (ADR-0020), so these are
 * a different four from `SESSION_ENDED`'s and mean a different thing: the key the Admin is
 * presenting as a storefront is missing, malformed, unknown or revoked. The storefront price
 * preview is the only thing in this Admin that ever presents one, and it forgets the key it
 * held when one of these comes back.
 *
 * It used to ask `reason.startsWith("api-key-")`, which compiles forever: a fifth reason not
 * spelled that way would have been missed, and a `PriceRefusal` from a Project's own Step —
 * whose `reason` is an **open** string (ADR-0060) — would have matched if it happened to start
 * with those characters. A `Record` keyed by the union is the convention for a reason
 * (ADR-0063).
 */
const API_KEY_REJECTED: Record<ApiKeyRefusal["reason"], true> = {
  "api-key-missing": true,
  "api-key-malformed": true,
  "api-key-unknown": true,
  "api-key-revoked": true,
};

/**
 * Whether the store gate rejected the key itself, as against refusing what was asked of it.
 *
 * Takes a refusal **body** rather than a thrown {@link Refused}, because the one caller reads
 * the client's result directly rather than through `orThrow` — it has to tell this apart from
 * every other refusal before it decides what to throw.
 */
export function isApiKeyRejected(refusal: unknown): boolean {
  return knownReasonOf(refusal, API_KEY_REJECTED) !== undefined;
}

/**
 * The two families `POST /admin/session` refuses through, as one set.
 *
 * Signing in is the one action in this Admin whose refusals span two schemas — a 400 from the
 * request hook above every handler (`InvalidRequest`), and a 401 from the handler itself
 * (`InvalidCredentials`) — and a Merchant looking at the form cares which of the three words
 * came back rather than which schema carried it. Both unions are spread into one `Record`, so
 * a reason added to **either** still has no key here and still fails the build.
 */
const SIGN_IN_REASONS: Record<
  InvalidCredentials["reason"] | InvalidRequest["reason"],
  true
> = {
  "invalid-credentials": true,
  invalid: true,
  "malformed-body": true,
};

/** Why signing in did not work, in kobai's own word for it. */
export const signInReasonOf = narrowing(SIGN_IN_REASONS);
