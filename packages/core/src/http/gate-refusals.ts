import { REFUSALS } from "./openapi.ts";

/**
 * The refusals a **gate** makes, and the mark that ties one to the middleware that makes it.
 *
 * A route declares the statuses it answers with, and since #9 those declarations are
 * published — in `packages/core/openapi.json` and in `@kobai/client`'s generated types. Four
 * of them are not the handler's to answer at all: they are made above it, by a middleware,
 * for every route that middleware sits in front of. A route declaring one of those is
 * therefore making a claim about its *middleware chain*, and nothing about the handler the
 * compiler checks can tell whether the claim is true.
 *
 * That is what this module exists for. Each gate is built through {@link gateAnswering},
 * naming the refusal it makes, and `openapi.test.ts` reads the mark back off Hono's own route
 * table — the thing dispatch actually reads — to check that what a route *declares* and what
 * its chain can *answer* are the same list. Both directions fail the build: a declared
 * `403` with no permission gate promises a check that does not exist, and a permission gate
 * with no declared `403` hides a refusal a generated client cannot narrow on.
 *
 * The mark goes inside the gate factories rather than on the route declarations, which is the
 * half that keeps this cheap: a route stays a `createRoute({…})` object listing its
 * responses, `middleware: [requirePermission(…)]` stays the whole of what gating one looks
 * like, and nothing is registered twice.
 */

/** A refusal made above the handler: the status it arrives at, and the response it is declared as. */
export type GateRefusal = {
  /** What a failure calls it — always the key it is listed under, put there by {@link named}. */
  readonly name: string;
  readonly status: 401 | 403 | 503;
  /**
   * The very object a route declares at that status. Held by reference rather than by name,
   * so the check has nothing to spell: it compares the declaration in the generated document
   * against this, and a `REFUSALS` entry that was reworded moves both at once.
   */
  readonly declaredAs: { readonly description: string };
};

/**
 * Every refusal a gate makes, and — the property the check leans on — the complete list.
 *
 * Each is answered by exactly one middleware and by no handler, which is what makes a route
 * declaring one a statement about its chain rather than about its own code. The other two
 * `REFUSALS` are deliberately absent: `invalid` comes from the validation hook and
 * `serverError` from the catch-all, and both belong to a route whether or not anything gates
 * it.
 *
 * A further gate added without an entry here is a gate whose refusal no route has to declare,
 * so add the entry in the same commit as the middleware.
 *
 * **Two of them are 403s, and they are two.** `forbidden` is a Merchant's Role being too
 * narrow, on the admin surface; `secretKeyRequired` is a browser's key on a store route that
 * takes money (ADR-0055). Sharing an entry would let a route declare one and be gated by the
 * other, which is the class of mistake this module exists to catch.
 */
export const GATE_REFUSALS = named({
  unavailable: { status: 503, declaredAs: REFUSALS.unavailable },
  noSession: { status: 401, declaredAs: REFUSALS.noSession },
  noApiKey: { status: 401, declaredAs: REFUSALS.noApiKey },
  forbidden: { status: 403, declaredAs: REFUSALS.forbidden },
  secretKeyRequired: { status: 403, declaredAs: REFUSALS.secretKeyRequired },
});

/**
 * Puts each entry's key on the entry, so a failure message can name a refusal it was handed.
 *
 * The alternative is writing the name twice, once as the key and once as a field, and the two
 * can then disagree — a mislabelled failure is a failure that sends somebody to the wrong
 * route. Here they cannot: there is one word, and the type says so.
 */
function named<Refusals extends Record<string, Omit<GateRefusal, "name">>>(
  refusals: Refusals,
): { [Name in keyof Refusals & string]: Refusals[Name] & { readonly name: Name } } {
  const entries = Object.entries(refusals).map(([name, refusal]) => [
    name,
    { ...refusal, name },
  ]);
  // `fromEntries` types its result by the key type alone, which is `string` — the assertion
  // restores what the argument already proved, that each entry is the one its key names.
  return Object.fromEntries(entries) as {
    [Name in keyof Refusals & string]: Refusals[Name] & { readonly name: Name };
  };
}

/**
 * The mark itself, as a symbol rather than a string key.
 *
 * A middleware is a function, and functions carry names, lengths and whatever a wrapper put
 * on them. A symbol cannot collide with any of that, and it does not appear in
 * `Object.keys`, so marking a handler changes nothing about how Hono or anything else sees
 * it.
 */
const ANSWERS = Symbol("kobai.gateRefusal");

type Marked = { [ANSWERS]?: GateRefusal };

/**
 * Builds a gate: the middleware, marked with the refusal it answers.
 *
 * Called inside the gate factory rather than at the mounting site, so a gate cannot be
 * mounted unmarked — there is no unmarked one to mount.
 *
 * The bound is a function rather than an object because a mark is only ever read back off
 * something Hono holds as a handler; marking anything else would put it somewhere
 * {@link refusalAnsweredBy} does not look.
 */
export function gateAnswering<Handler extends (...args: never[]) => unknown>(
  refusal: GateRefusal,
  handler: Handler,
): Handler {
  return Object.assign(handler, { [ANSWERS]: refusal });
}

/**
 * The refusal this route-table entry answers, or `undefined` if it is not a gate.
 *
 * Read off the handler Hono holds, which is the same object the factory returned:
 * `Hono.route()` carries a mounted app's handlers across by reference, and only wraps them
 * when the mounted app has an error handler of its own — none of kobai's sub-apps does. A
 * sub-app that grew one would hide its gates from this, and the check would fail loudly
 * rather than quietly, because every route below it declares refusals nothing would then be
 * seen to make.
 */
export function refusalAnsweredBy(handler: unknown): GateRefusal | undefined {
  return typeof handler === "function" ? (handler as Marked)[ANSWERS] : undefined;
}
