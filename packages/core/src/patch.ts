import { asMetadata, metadataDetail, trimmed } from "./input.ts";

/**
 * Reading a `PATCH` body: which fields it named, and whether it named any at all.
 *
 * Every correction on this surface answers the same two questions before it touches a row, and
 * ADR-0062 settled both: **an absent field means "leave it"**, and **a body naming nothing the
 * route would change is refused at 400** rather than answered 200 with the row unchanged,
 * because a request that changes nothing is more likely a mistake than an intention. A named
 * `metadata` is **replaced** rather than merged, for the reason `input.ts` gives.
 *
 * They were written out once per module — five copies of the emptiness test and six of the
 * narrowing loop, across four files — and they had already drifted (#185): two of the six
 * refusals were missing the sentence the other four share, and half the `metadata` refusals
 * named the field in backticks where the rest named it bare. This is `catalog/lock.ts`'s answer
 * to the same shape one layer down (#160) — the rule everyone agrees on, implemented once.
 *
 * **Why a shared helper may return a refusal at all.** Under ADR-0060 each module's `reason`
 * union is bound to that module by a mapped `satisfies` in `http/`, so a helper answering with
 * some union of its own would cost the binding that makes a renamed reason fail the build —
 * and that binding is worth more than the deduplication. It needs none: every narrowing here
 * refuses `invalid`, which is a **literal** and a member of all five unions, so
 * {@link NotUsable} is assignable into each of them and a module that renamed its `invalid`
 * still reddens. The type parameter exists for the one field that refuses something else —
 * `PATCH /admin/variants/{id}`'s `fulfilment`, which answers `unknown-fulfilment-strategy` —
 * and it *widens* the refusal rather than replacing it, so the literal is always still there.
 *
 * **What is deliberately not here.** No rule: whether a SKU is taken, whether this Store prices
 * in that currency, whether stripping a Permission would lock the deployment out. Those stay in
 * the module that owns them and answer with their own `reason`. That is also why this is not
 * `input.ts`, which holds the same kind of small shared narrowings and promises in as many
 * words to hold no rule — the emptiness refusal *is* a rule, settled once by ADR-0062 for every
 * route rather than owned by one of them, and it needed somewhere that could say so.
 */

/**
 * A refusal a narrowing makes: `invalid` always, plus whatever a field of the caller's own
 * refuses beside it.
 *
 * Deliberately not generic in the whole `reason`. `invalid` is written here as a literal so
 * that the assignment into each module's own union is what checks the two agree — see the
 * header.
 */
export type NotUsable<R extends string = never> = {
  readonly ok: false;
  readonly reason: R | "invalid";
  readonly detail: string;
};

/**
 * How one field narrows: the value it becomes, or the refusal it earns.
 *
 * Named for the **field it reads** rather than for its being a function, because that is how it
 * is written down — a `fields` table maps each column to one of these, and `sku: text("sku")`
 * reads as what the field is rather than as what reads it.
 */
export type Field<V, R extends string = never> = (
  value: unknown,
) => { readonly ok: true; readonly value: V } | NotUsable<R>;

/**
 * What {@link changesFrom} answers: the changes a body asked for, or why it asked for none.
 *
 * `C` is written **mutable** and the changes come back as `Partial<C>`, because {@link
 * changesFrom} fills the object a key at a time. Everything else in this file is `readonly`; a
 * caller that wants its own changes read-only says so at its own boundary.
 */
export type Changes<C, R extends string = never> =
  | { readonly ok: true; readonly changes: Partial<C> }
  | NotUsable<R>;

/**
 * The `invalid` refusal, built.
 *
 * Exported so that a field narrowing a module writes for itself — `readRoleInput`'s
 * `permissions`, which is the only one — says it the same way rather than hand-rolling the very
 * literal this file exists to hold once.
 */
export function notUsable(detail: string): NotUsable {
  return { ok: false, reason: "invalid", detail };
}

/**
 * Reads a `PATCH` body into the set of changes it asks for.
 *
 * `named` is what the body carried and `fields` is how each one narrows — **keyed by the
 * column rather than by the wire**, which is what makes the result the very object a `set`
 * takes. Where the two names differ the caller re-keys in the literal it passes
 * (`{ fulfilmentStrategy: input.fulfilment }`), because one object literal at the one site
 * that needs it is cheaper to read than a mapping this function would have to carry for
 * everybody.
 *
 * A field the body did not name is not narrowed at all and is absent from the result, which is
 * the whole of "an absent field means leave it". A field `fields` does not mention is ignored
 * however the body named it — the route's schema has already stripped it, and its arriving here
 * is exactly the empty body {@link changesNothing} is for.
 *
 * **`whenNothing` is optional because two callers cannot use it.** `updateStore` must wait: a
 * body naming only the currency it already prices in has named something, and whether *that*
 * changes nothing is a question about the row. `readRoleInput` is shared with `createRole`,
 * where an empty result is a missing `name` rather than a no-op. Both ask afterwards, and both
 * answer with {@link changesNothing} like everyone else.
 */
export function changesFrom<C extends object, R extends string = never>(
  // `NoInfer`, because every value here is `unknown` and a body is what a route was *sent*:
  // left inferring, `C` came out of this literal as `{ title: unknown; metadata: unknown }` and
  // the changes it answered with were unusable by any `set`. `fields` is the side that knows.
  named: NoInfer<{ readonly [K in keyof C]: unknown }>,
  fields: { readonly [K in keyof C]: Field<C[K], R> },
  whenNothing?: NotUsable,
): Changes<C, R> {
  const changes: Partial<C> = {};

  for (const key of Object.keys(fields) as (keyof C)[]) {
    const value = named[key];
    if (value === undefined) continue;

    const narrowed = fields[key](value);
    if (!narrowed.ok) return narrowed;

    // The one cast TypeScript cannot be talked out of: `key` is a `keyof C` the loop chose, so
    // `fields[key]` is the union of every field's narrowing and its `value` the union of every
    // change's type. That is right for each key and unprovable across the loop, and `fields`
    // being keyed by `C` is what makes it true.
    changes[key] = narrowed.value as C[keyof C];
  }

  if (whenNothing !== undefined && Object.keys(changes).length === 0) return whenNothing;
  return { ok: true, changes };
}

/**
 * What a body naming nothing this route would change is told.
 *
 * `fields` names what may be named; `instead` is the route's own second half, and it is the
 * second job ADR-0062 gives this refusal. The schema strips a field the route does not carry,
 * so a Merchant who sent a Price to a Variant, a `variants` to a Product or only a
 * `defaultCurrency` to the Store sent an empty body — and this is the one place they can be
 * told which route does it.
 *
 * **`fields` is prose and is deliberately not derived from the table {@link changesFrom} was
 * given.** It names the fields as the **wire** spells them and that table is keyed by the
 * column, and `PATCH /admin/variants/{id}` is the case where the two differ: a caller sends
 * `fulfilment` and the column is `fulfilment_strategy`, so a derived sentence would name a field
 * no body may carry. The English differs too — "or both" for two fields, "or any of them" for
 * three — and that is a sentence rather than a list. What keeps it honest is a test instead:
 * `http/a-correction-that-changes-nothing.test.ts` reads every field this sentence names back
 * out of it and holds each one to the route's own request schema, so a renamed or mistyped field
 * reddens the build.
 */
export function changesNothing(fields: string, instead?: string): NotUsable {
  const said = `Name ${fields}. A request that changes nothing is more likely a mistake than an intention.`;
  return notUsable(instead === undefined ? said : `${said} ${instead}`);
}

/**
 * What a field that has to be a non-empty string is told.
 *
 * Exported beside {@link text} because a caller sometimes needs the same words for a field that
 * is **absent entirely** — `createRole` does, where {@link text} never runs — and the same
 * mistake should read the same either way.
 */
export function mustBeText(field: string): string {
  return `\`${field}\` must be a non-empty string.`;
}

/** A non-empty string, trimmed — the commonest field a correction carries. */
export function text(field: string): Field<string> {
  return (value) => {
    const result = trimmed(value);
    return result === undefined
      ? notUsable(mustBeText(field))
      : { ok: true, value: result };
  };
}

/**
 * ADR-0004's open data: any JSON object, **replacing** what is stored rather than merging into
 * it, because a merge leaves no way to take back out a key a Merchant put there by mistake.
 */
export function openData(field: string): Field<Record<string, unknown>> {
  return (value) => {
    const metadata = asMetadata(value);
    return metadata === undefined
      ? notUsable(metadataDetail(`\`${field}\``))
      : { ok: true, value: metadata };
  };
}
