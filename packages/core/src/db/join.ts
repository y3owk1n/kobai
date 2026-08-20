/**
 * Reading a `left join` back, in the one place that knows the trap (#292).
 *
 * **Drizzle answers a nested selection from a left join as an object of `null`s rather than as
 * `null`**, so a row that joined nothing arrives as `{ id: null, name: null }` — which is truthy,
 * and which every naive `row.thing ?? null` therefore reports as a thing. The identifier is what
 * says whether there was a row, because a primary key is the one column that cannot be null in a
 * row that exists.
 *
 * It was written out at four sites before this existed — the Store's default Region, an API
 * key's Channel, and a Price's Region and Channel — each with its own copy of that sentence, and
 * a fifth would have got to rediscover it. `store.test.ts`, `channel.test.ts` and
 * `catalog.test.ts` are where the behaviour is actually held: a Store with no default Region
 * reads `null`, a key in no Channel reads `null`, and an unconstrained Price reads `null` for
 * both.
 */

/**
 * The joined row, or `null` where the join found nothing.
 *
 * The cast is the whole reason this is a function: Drizzle types the selection as though every
 * column were present, and what arrives is that shape *or* the same keys holding `null`. Asking
 * the identifier is the check; the cast is what says the check was made.
 */
export function joined<T extends { readonly id: string }>(
  row: T | null | undefined,
): T | null {
  return (row as { readonly id?: string | null } | null | undefined)?.id == null
    ? null
    : (row as T);
}
