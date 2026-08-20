import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Queryable, Transaction } from "../db/client.ts";
import { productOption, variant, variantOptionValue } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import { isJsonObject, trimmed } from "../input.ts";
import { type NotUsable, notUsable } from "../patch.ts";

/**
 * A Product's **options**, and each Variant's value for each of them.
 *
 * A Variant used to be a bare SKU, so a storefront built on kobai could offer a Shopper a
 * dropdown of opaque codes and nothing better (stories 11, 12, 20). What makes a picker
 * possible is two facts and no third: **the Product's options, in the order the Merchant put
 * them in**, and **each Variant's value for each**. A storefront that has those maps a chosen
 * combination to a SKU by itself, which is why there is deliberately no route that takes a
 * combination and answers a Variant — the Product detail payload already settles the question,
 * and a route would be a second answer to it that could disagree.
 *
 * **A combination nothing answers is absent rather than refused** (story 21). A Product with
 * three Sizes and two Colours need not have six Variants, and the page a Shopper is looking at
 * has to be able to say "not that one" without kobai having an opinion about it. So nothing
 * here requires the Variants to cover the grid; what it requires is the other direction.
 *
 * **The rule, and it is one rule read in both directions**: a Variant carries a value for every
 * option its Product declares, and for no option it does not. One that names an option the
 * Product never declared is a value nothing can interpret; one that leaves a declared option
 * unanswered is a Variant a picker cannot place. Both are {@link VARIANT_OPTIONS_MISMATCH},
 * refused at 422 wherever a Variant is written — inside a create, adding one to a Product that
 * already exists, and correcting one — because it is one fact about a Variant and its Product,
 * and where the Product happens to have been declared in the same request changes neither what
 * is wrong nor how it is fixed.
 *
 * **The second rule, and it is about a Variant's *siblings* rather than about its Product**
 * (#277): no two Variants of one Product may answer its options the same way. The unique index
 * is `(variant_id, option_id)`, which makes a Variant's answer to one option single and says
 * nothing whatever about two Variants agreeing on every option — so until this was written a
 * Product could hold two Variants both answering `Size: S, Colour: Red`, and the payload above
 * was one a storefront could not choose from: the mapping it rests on is a **function**, and
 * where two Variants share a combination it is not one. The picker would take whichever it met
 * first. {@link VARIANT_COMBINATION_TAKEN} is the word, refused wherever a Variant is written
 * against siblings that already exist — {@link combinationTaken} is the question — and a create
 * naming one combination twice is refused `invalid` instead, because a body that conflicts with
 * *itself* is not the Store refusing anything (`variants` naming one SKU twice draws that same
 * line against `sku-taken`).
 *
 * **Only a Variant that answers *every* option its Product declares answers a combination at
 * all.** One left short by an option added since (below) is unplaceable by a picker rather than
 * ambiguous with anything, so it is compared with nothing — and a Product declaring **no**
 * options has no combinations, which is why several Variants under one may be told apart by
 * their SKUs alone, as they always could.
 *
 * **A Product's own list is corrected freely, and the one correction that is judged against its
 * Variants is one that would collide two of them** (#277's ruling). The asymmetry is the whole
 * of it, and it is worth reading rather than remembering:
 *
 * - **Adding an option leaves the Variants under it unanswered and is never refused.** Judging
 *   them would refuse the correction for every Variant at once, with the only remedy being to
 *   delete the Product and build it again (ADR-0059, and `the-http-surface.md`'s rule — a
 *   refusal whose advice names no reachable control is a finding rather than something to word
 *   around). So they read back truthfully short until each is corrected, exactly as a Variant
 *   with no Price is unsellable until one is set. It falls out of the rule above rather than
 *   being excepted from it: an option nothing has answered leaves no Variant complete, so there
 *   is nothing for two of them to share.
 * - **Removing one is refused where it would collide two Variants**, naming them, because here
 *   the repair *is* a control a Merchant has: correct or delete one of the pair and send the
 *   correction again. The removal still takes every Variant's answer to the option with it by
 *   cascade when it is allowed. The two cases differ in precisely that — whether a reachable
 *   repair exists — and not in how much is being taken away.
 */

/** One option a Product declares, as a read reports it. */
export type ProductOption = {
  readonly id: string;
  readonly name: string;
};

/** A Variant's value for one option, named the way the Product names it. */
export type VariantOptionValue = {
  readonly name: string;
  readonly value: string;
};

/**
 * What a request declaring a Product's options asked for — a name, and its place in the list.
 *
 * `position` is not a field a body carries: it is the order of the array itself, so the one
 * thing a Merchant does to reorder options is send them in another order.
 */
type OptionDeclaration = { readonly name: string };

/**
 * What a correction asked for: the same, plus which existing option each entry *is*.
 *
 * `id` absent is an option this Product did not have, which is how one is added. An entry with
 * an `id` is the option that already carries it, renamed or moved or both — and identity is why
 * the `id` is on the wire at all: a rename read as a removal and an addition would take every
 * Variant's answer to it with it, which is the one thing a typo fix must not do.
 */
type OptionCorrection = { readonly id?: string; readonly name: string };

/** The one word every route refuses a Variant's values with. */
export const VARIANT_OPTIONS_MISMATCH = "variant-options-mismatch";

/** A Variant whose values are not exactly its Product's declared options. */
export type OptionsMismatch = {
  readonly ok: false;
  readonly reason: typeof VARIANT_OPTIONS_MISMATCH;
  readonly detail: string;
};

/**
 * The one word every route refuses a Variant's **siblings** with (#277).
 *
 * One word for one fact, wherever it is asked from: adding a Variant, correcting one, and
 * correcting the Product's option list under both. A combination identifies one Variant, which
 * is the same thing a SKU does one column along — so this is `sku-taken`'s word and
 * `sku-taken`'s status, for `sku-taken`'s reason.
 */
export const VARIANT_COMBINATION_TAKEN = "variant-combination-taken";

/** A Variant answering a combination another Variant of the same Product already answers. */
export type CombinationTaken = {
  readonly ok: false;
  readonly reason: typeof VARIANT_COMBINATION_TAKEN;
  readonly detail: string;
};

/**
 * Why two Variants may not answer one combination, in one sentence and one place.
 *
 * Three refusals say it — a Variant added onto a sibling's combination, a create naming one
 * twice in its own body, and a correction that would leave two sharing one — and it is one fact
 * about the Store rather than three, exactly as `skuTaken` is one sentence for two routes. What
 * each of them adds is the repair, which is different at each.
 */
const WHY_ONE_ANSWERS =
  "A storefront maps a combination a Shopper chose to one Variant, so two of them cannot answer it";

type Parsed<V> = { readonly ok: true; readonly value: V } | NotUsable;

/**
 * The options a create declares, out of the body it arrived in — `[]` where it named none.
 *
 * A Product with no options at all is the ordinary case rather than the exception, exactly as
 * one with a single Variant is (ADR-0008): a poster that comes in one size declares nothing
 * here and every Variant of it carries no values, which the rule above is satisfied by
 * trivially.
 */
export function parseOptionDeclarations(value: unknown): Parsed<OptionDeclaration[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return notUsable(
      '`options` must be a list of the options this Product is chosen by, in the order a storefront should offer them — e.g. [{ "name": "Size" }, { "name": "Colour" }].',
    );
  }

  const declared: OptionDeclaration[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      return notUsable("Each entry in `options` must be an object with a `name`.");
    }

    const name = trimmed(entry.name);
    if (name === undefined) {
      return notUsable("Each option's `name` must be a non-empty string.");
    }

    // The one question a list asks that a single entry cannot. Two options called Size are two
    // answers a Variant would have to give to one question, and the second would be the value
    // for whichever row a reader happened to see first.
    if (seen.has(name)) return notUsable(namedTwice(name));
    seen.add(name);

    declared.push({ name });
  }

  return { ok: true, value: declared };
}

/**
 * The options a correction asks for — **the whole list**, in the order it should end up in.
 *
 * Whole rather than a set of edits, for the reason a `PATCH`'s `metadata` is replaced rather
 * than merged (ADR-0062): a list of edits leaves no way to say "and this one is gone", and the
 * order is a property of the list rather than of any entry in it.
 */
export function parseOptionCorrections(value: unknown): Parsed<OptionCorrection[]> {
  if (!Array.isArray(value)) {
    return notUsable(
      "`options` must be the complete list of this Product's options, in the order a storefront should offer them. An entry with an `id` is the option that already carries it, renamed or moved; one without is a new option; one this Product has and the list does not name is removed, and every Variant's value for it goes with it.",
    );
  }

  const asked: OptionCorrection[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      return notUsable("Each entry in `options` must be an object with a `name`.");
    }

    const name = trimmed(entry.name);
    if (name === undefined) {
      return notUsable("Each option's `name` must be a non-empty string.");
    }
    if (names.has(name)) return notUsable(namedTwice(name));
    names.add(name);

    if (entry.id === undefined) {
      asked.push({ name });
      continue;
    }

    const id = trimmed(entry.id);
    if (id === undefined || !isUuid(id)) {
      return notUsable(
        "An option's `id` must be the identifier a read of this Product reported for it. Leave it out entirely to declare a new option.",
      );
    }
    if (ids.has(id)) {
      return notUsable(
        `\`options\` names the option ${JSON.stringify(id)} twice. One option is one entry, and its place in the list is its order.`,
      );
    }
    ids.add(id);

    asked.push({ id, name });
  }

  return { ok: true, value: asked };
}

/**
 * A Variant's values, out of whichever body they arrived in — `[]` where it named none.
 *
 * `possessive` is the only difference between reading a create's nested Variants and reading a
 * body that *is* one Variant, exactly as it is for the SKU beside it: a create names a list and
 * has to say which entry is wrong.
 */
export function parseOptionValues(
  value: unknown,
  possessive: "" | "Each Variant's ",
): Parsed<VariantOptionValue[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return notUsable(
      `${possessive}\`options\` must be a list of this Variant's value for each option its Product declares — e.g. [{ "name": "Size", "value": "M" }].`,
    );
  }

  const values: VariantOptionValue[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      return notUsable(
        `Each entry in ${possessive}\`options\` must be an object with a \`name\` and a \`value\`.`,
      );
    }

    const name = trimmed(entry.name);
    if (name === undefined) {
      return notUsable(
        `Each of ${possessive}\`options\` must name an option: its \`name\` must be a non-empty string.`,
      );
    }

    const written = trimmed(entry.value);
    if (written === undefined) {
      return notUsable(
        `Each of ${possessive}\`options\` must carry a \`value\`, as a non-empty string. A Variant that has no answer for an option is a Variant a picker cannot place.`,
      );
    }

    if (seen.has(name)) {
      return notUsable(
        `${possessive}\`options\` answers ${JSON.stringify(name)} twice. One option is one value.`,
      );
    }
    seen.add(name);

    values.push({ name, value: written });
  }

  return { ok: true, value: values };
}

/**
 * Whether these values are exactly those options, and what to say when they are not.
 *
 * `undefined` is the answer being yes, so the call site reads as the guard it is. `which` names
 * the Variant the way the request does — by SKU where the body carries one, and as "This
 * Variant" where the route already addressed it.
 */
export function variantOptionsMismatch(
  declared: readonly { readonly name: string }[],
  values: readonly VariantOptionValue[],
  which: string,
): OptionsMismatch | undefined {
  const answered = new Set(values.map((one) => one.name));
  const options = new Set(declared.map((one) => one.name));

  const unanswered = declared
    .filter((one) => !answered.has(one.name))
    .map((one) => one.name);
  const undeclared = values
    .filter((one) => !options.has(one.name))
    .map((one) => one.name);
  if (unanswered.length === 0 && undeclared.length === 0) return undefined;

  const faults: string[] = [];
  if (unanswered.length > 0) faults.push(`leaves ${quoted(unanswered)} unanswered`);
  if (undeclared.length > 0) {
    faults.push(`names ${quoted(undeclared)}, which this Product does not declare`);
  }

  return {
    ok: false,
    reason: VARIANT_OPTIONS_MISMATCH,
    detail: `${which} must carry a value for every option its Product declares and for no other: it ${faults.join(", and it ")}. This Product declares ${
      declared.length === 0 ? "no options at all" : quoted([...options])
    }.`,
  };
}

/**
 * Whether a sibling of this Product already answers this combination — the rule at every route
 * that writes a Variant into a Product that already exists (#277).
 *
 * `undefined` is the answer being no, so the call site reads as the guard it is. `which` names
 * the Variant the way the request does, exactly as {@link variantOptionsMismatch}'s does, and
 * `except` is the Variant being corrected: a Variant may keep the combination it already has,
 * which is what makes correcting a *different* field of it possible at all.
 *
 * **The caller has taken {@link lockProductOptions} before the read.** This is a `select` over
 * other rows followed by an `insert` of one, which is the shape ADR-0018 exists to rule out: two
 * Variants written at the same instant each read a Product that does not yet hold the other, and
 * both are allowed through. No constraint can stand in for it — the fact is spread over one row
 * per option — so the advisory lock is what makes the read and the write one operation.
 *
 * **Only a Variant answering every declared option is compared, and a Product declaring none is
 * not judged at all.** Both are the same sentence read from two ends: a combination is what a
 * picker chooses, so where there is nothing to choose there is nothing two Variants can answer
 * the same way, and a Variant left short by an option added since is unplaceable rather than
 * ambiguous.
 */
export async function combinationTaken(
  tx: Transaction,
  productId: string,
  declared: readonly ProductOption[],
  values: readonly VariantOptionValue[],
  which: string,
  except?: string,
): Promise<CombinationTaken | undefined> {
  const wanted = combinationOfValues(declared, values);
  if (wanted === undefined) return undefined;

  const held = await readVariantCombinations(tx, productId);
  const key = keyOf(wanted);
  const taken = held.find((one) => {
    if (one.variantId === except) return false;
    const answers = restrictedTo(one.byOption, declared);
    return answers !== undefined && keyOf(answers) === key;
  });
  if (!taken) return undefined;

  return {
    ok: false,
    reason: VARIANT_COMBINATION_TAKEN,
    detail: `${which} answers ${spelled(declared, (option) => option.id, wanted)}, and the Variant ${JSON.stringify(taken.sku)} already answers that combination. ${WHY_ONE_ANSWERS} — give this one a combination of its own, or correct or delete ${JSON.stringify(taken.sku)}.`,
  };
}

/**
 * The same question asked of a create's own list, which is a different question (#277).
 *
 * A create's Variants have no siblings — the Product is being made in the same transaction — so
 * what two of them sharing a combination conflicts with is the **body**, not the Store. That is
 * `invalid` at 400 rather than {@link VARIANT_COMBINATION_TAKEN} at 409, on exactly the
 * distinction `variants` naming one SKU twice already draws against `sku-taken`: a 409 says
 * somebody got there first and invites the same request again, and this request will never be
 * accepted as it stands.
 *
 * It answers the sentence rather than a refusal, because the caller is the one that knows the
 * word: it is one of `createProduct`'s `invalid`s.
 */
export function combinationNamedTwice(
  declared: readonly { readonly name: string }[],
  variants: readonly {
    readonly sku: string;
    readonly options: readonly VariantOptionValue[];
  }[],
): string | undefined {
  if (declared.length === 0) return undefined;

  const skuByCombination = new Map<string, string>();
  for (const one of variants) {
    // Named by the option's own name here rather than by an identifier, because nothing has
    // been written yet and there is no identifier to name it by. It is the same key: a Product
    // declares one option of a name, which `parseOptionDeclarations` has already held.
    const wanted = new Map(one.options.map((value) => [value.name, value.value]));
    if (wanted.size !== declared.length) continue;

    const key = keyOf(wanted);
    const first = skuByCombination.get(key);
    if (first !== undefined) {
      return `\`variants\` names ${JSON.stringify(first)} and ${JSON.stringify(one.sku)}, which answer this Product's options the same way — ${spelled(declared, (option) => option.name, wanted)}. ${WHY_ONE_ANSWERS}.`;
    }
    skuByCombination.set(key, one.sku);
  }

  return undefined;
}

/**
 * Whether correcting this Product's options to the list it was given would leave two Variants
 * answering one combination — the ruling on #277.
 *
 * **It is asked of the correction rather than of the Variants**, which is what keeps #253's
 * decision intact rather than reopening it: an entry with no `id` is an option no Variant has
 * answered yet, so a correction that adds one leaves every Variant short and this returns
 * `undefined` without comparing anything. What can collide two Variants is a **removal** — and
 * there the repair is a control a Merchant has, which is the whole of why one is refused and
 * the other is not.
 *
 * Keyed by the option's **identifier**, because a correction may be renaming one and two names
 * for one question are still one question — so a rename and a reorder collide nothing, the
 * combinations either side of them being the same combinations.
 *
 * **The ruling says a correction that would *newly* collide two Variants, and this asks only
 * whether it would leave two colliding.** They are the same question while every write path
 * refuses a collision: a Product holding one is a Product no request could have produced, so
 * there is no correction the two answers disagree about — and asking it twice, before and
 * after, would be a branch nothing can reach and no test can arrange. It stops being the same
 * question the day rows written before this rule exist, by hand or under an older deployment,
 * and on such a Product every correction of the option list is refused until one of the pair is
 * repaired — reachable, but a refusal for a fault the request did not introduce. That is when
 * to write the second reading, not before.
 */
async function correctionWouldCollide(
  tx: Transaction,
  productId: string,
  asked: readonly OptionCorrection[],
  removed: readonly ProductOption[],
): Promise<CombinationTaken | undefined> {
  const kept = asked.flatMap((one) =>
    one.id === undefined ? [] : [{ ...one, id: one.id }],
  );
  // A Product left declaring nothing has no combinations, and one left declaring an option
  // nothing has answered leaves no Variant complete. Neither is a state two Variants can share.
  if (kept.length === 0 || kept.length !== asked.length) return undefined;

  const held = await readVariantCombinations(tx, productId);
  const skuByCombination = new Map<string, string>();
  for (const one of held) {
    const answers = restrictedTo(one.byOption, kept);
    if (answers === undefined) continue;

    const key = keyOf(answers);
    const first = skuByCombination.get(key);
    if (first !== undefined) {
      return {
        ok: false,
        reason: VARIANT_COMBINATION_TAKEN,
        detail: `This correction would leave the Variants ${JSON.stringify(first)} and ${JSON.stringify(one.sku)} both answering ${spelled(kept, (option) => option.id, answers)}${
          removed.length === 0
            ? ""
            : `, because it removes ${quoted(removed.map((option) => option.name))}`
        }. ${WHY_ONE_ANSWERS} — correct or delete one of the two and send this correction again.`,
      };
    }
    skuByCombination.set(key, one.sku);
  }

  return undefined;
}

/**
 * A Variant's answers as this write is given them, by option identifier — or `undefined` where
 * it has not answered every option, which is a Variant that answers no combination at all.
 */
function combinationOfValues(
  declared: readonly ProductOption[],
  values: readonly VariantOptionValue[],
): Map<string, string> | undefined {
  if (declared.length === 0) return undefined;

  const byName = new Map(values.map((one) => [one.name, one.value]));
  const wanted = new Map<string, string>();
  for (const option of declared) {
    const value = byName.get(option.name);
    if (value === undefined) return undefined;
    wanted.set(option.id, value);
  }
  return wanted;
}

/**
 * The answers this Variant holds for exactly these options — `undefined` where one is missing.
 *
 * Answers to options that are not in the list are dropped rather than being a mismatch, which
 * is what lets a correction ask this about the list a Product is *about* to have.
 */
function restrictedTo(
  byOption: ReadonlyMap<string, string>,
  options: readonly { readonly id: string }[],
): Map<string, string> | undefined {
  const answers = new Map<string, string>();
  for (const option of options) {
    const value = byOption.get(option.id);
    if (value === undefined) return undefined;
    answers.set(option.id, value);
  }
  return answers;
}

/**
 * One combination as a string, so that two of them compare with `===`.
 *
 * Sorted by the key, because the order the rows came back in is not part of the fact — two
 * Variants answering `Size: S, Colour: Red` do so whichever way round the rows were read.
 */
function keyOf(answers: ReadonlyMap<string, string>): string {
  return JSON.stringify([...answers].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/**
 * `Size "S" and Colour "Red"`, in the Product's own order — what a refusal names.
 *
 * `keyed` is how the caller says what its answers are keyed by, which is the option's
 * identifier everywhere a Product exists and its name inside a create, where there is not yet
 * one to name it by.
 */
function spelled<O extends { readonly name: string }>(
  options: readonly O[],
  keyed: (option: O) => string,
  answers: ReadonlyMap<string, string>,
): string {
  return listed(
    options.flatMap((option) => {
      const value = answers.get(keyed(option));
      return value === undefined ? [] : [`${option.name} ${JSON.stringify(value)}`];
    }),
  );
}

/** Every Variant of one Product, with the value it holds for each option, by identifier. */
async function readVariantCombinations(
  db: Queryable,
  productId: string,
): Promise<
  readonly {
    readonly variantId: string;
    readonly sku: string;
    readonly byOption: ReadonlyMap<string, string>;
  }[]
> {
  // A `leftJoin`, so a Variant that has answered nothing is still a Variant this read knows
  // about — it answers no combination, which is a fact the callers ask rather than infer from
  // an absence.
  const rows = await db
    .select({
      variantId: variant.id,
      sku: variant.sku,
      optionId: variantOptionValue.optionId,
      value: variantOptionValue.value,
    })
    .from(variant)
    .leftJoin(variantOptionValue, eq(variantOptionValue.variantId, variant.id))
    .where(eq(variant.productId, productId));

  const byVariant = new Map<string, { sku: string; byOption: Map<string, string> }>();
  for (const row of rows) {
    let one = byVariant.get(row.variantId);
    if (one === undefined) {
      one = { sku: row.sku, byOption: new Map() };
      byVariant.set(row.variantId, one);
    }
    if (row.optionId !== null && row.value !== null)
      one.byOption.set(row.optionId, row.value);
  }

  return [...byVariant].map(([variantId, one]) => ({ variantId, ...one }));
}

/**
 * The options a Product declares, in the order it declared them.
 *
 * `Queryable`, so a write can read back the list it just wrote inside its own transaction —
 * `readVariants`'s reason, and the reason a correction answers with the Product this write left
 * rather than with whatever the next request leaves between two statements.
 */
export async function readProductOptions(
  db: Queryable,
  productId: string,
): Promise<ProductOption[]> {
  return (
    db
      .select({ id: productOption.id, name: productOption.name })
      .from(productOption)
      .where(eq(productOption.productId, productId))
      // `id` breaks the tie. Positions are rewritten dense from every request that declares them,
      // so nothing should ever tie — which is exactly the kind of thing a total order should not
      // be left resting on.
      .orderBy(asc(productOption.position), asc(productOption.id))
  );
}

/**
 * Each of these Variants' values, keyed by Variant and **in their Product's option order**.
 *
 * One query rather than one per Variant, and a join rather than two reads, because the name a
 * value is reported under and the order they come back in both live on the option row. A
 * Variant with no values at all is simply absent from the map, which is what a Product
 * declaring no options leaves every Variant as.
 */
export async function readVariantOptionValues(
  db: Queryable,
  variantIds: readonly string[],
): Promise<Map<string, VariantOptionValue[]>> {
  const byVariant = new Map<string, VariantOptionValue[]>();
  // `in ()` is not a query Postgres will run, and a Product's Variants are never zero — but a
  // caller reading one Variant that turned out not to exist reaches here with an empty list.
  if (variantIds.length === 0) return byVariant;

  const rows = await db
    .select({
      variantId: variantOptionValue.variantId,
      name: productOption.name,
      value: variantOptionValue.value,
    })
    .from(variantOptionValue)
    .innerJoin(productOption, eq(productOption.id, variantOptionValue.optionId))
    .where(inArray(variantOptionValue.variantId, [...new Set(variantIds)]))
    .orderBy(asc(productOption.position), asc(productOption.id));

  for (const row of rows) {
    const existing = byVariant.get(row.variantId);
    const one = { name: row.name, value: row.value };
    if (existing) existing.push(one);
    else byVariant.set(row.variantId, [one]);
  }

  return byVariant;
}

/**
 * Writes the options a Product is created with, and answers with them.
 *
 * The positions are the list's own order, which is the whole of "an order the Merchant sets".
 */
export async function declareProductOptions(
  tx: Transaction,
  productId: string,
  declared: readonly OptionDeclaration[],
): Promise<ProductOption[]> {
  if (declared.length === 0) return [];

  return tx
    .insert(productOption)
    .values(declared.map((one, position) => ({ productId, name: one.name, position })))
    .returning({ id: productOption.id, name: productOption.name });
}

/**
 * Serialises every write that reads one Product's options and writes against what it read, for
 * the length of the transaction.
 *
 * **Three things take it, and they take the same key on purpose** (#253, #277): correcting the
 * Product's option list, adding a Variant to it, and correcting a Variant's values. The last two
 * judge a combination against the Variant's siblings, which is a read of other rows followed by
 * a write — and a correction of the option list running between the two would judge against a
 * list that no longer exists. Two keys would serialise each kind against itself and neither
 * against the other, which is a collision reached by two writes that each refused to cause one.
 *
 * **Taken before the read, and it is a `pg_advisory_xact_lock` rather than a row lock** — the
 * same departure from ADR-0018's usual answer that `holdReservations` and the last-administrator
 * guard make, for their reason. Inventory claims a scarce thing with
 * `update … where on_hand - reserved >= n` because the condition is about *the row being
 * written*; this condition is about **other rows** — which options this Product has — and a
 * `select` reads those without locking them, so two corrections arriving together each read the
 * old list and each write the list they wanted. The option one of them added then survives under
 * a list the other had already replaced, and two of them appending `Colour` leave a Product with
 * two options of that name.
 *
 * **`lockProduct` cannot do this job and it was written believing it could.** That lock is
 * `for share`, and two `FOR SHARE` holders do not conflict in Postgres — it keeps a `DELETE` out,
 * which is what existence needs, and serialises nothing against another correction. The row lock
 * is still taken beside this one, and still only for existence.
 *
 * The **two-argument** form, so two Products never wait for each other; the namespace is
 * arbitrary but fixed, exactly as `CART_HOLD_LOCK_NAMESPACE` is, and Postgres keeps two-argument
 * keys apart from one-argument ones so this cannot collide with the two deployment-wide keys in
 * `auth/`. A `hashtext` collision costs a wait and never a wrong answer: the lock decides who
 * reads first, never what they read.
 *
 * `two-corrections-of-one-option-list.test.ts` is the assertion, and it has been watched failing
 * with this line removed.
 */
export async function lockProductOptions(
  tx: Transaction,
  productId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${PRODUCT_OPTIONS_LOCK_NAMESPACE}, hashtext(${productId}))`,
  );
}

/** The namespace every correction of a Product's options serialises in, per Product. */
const PRODUCT_OPTIONS_LOCK_NAMESPACE = 611_204_017;

/**
 * Corrects a Product's options to the list it was given: renamed, reordered, added, removed.
 *
 * **Every write here happens after every judgement**, so a refusal leaves the Product exactly
 * as it was — which is what lets the caller return one from inside its transaction rather than
 * throwing to unwind it. There are **two** judgements since #277: an `id` this Product does not
 * have, and a correction that would leave two Variants answering one combination.
 *
 * **The caller has taken {@link lockProductOptions} and then `lockProduct`**, in that order and
 * before the read below. The first is what makes this read-then-write one operation; the second
 * is only existence, so the rows written here cannot reference a Product that has gone.
 */
export async function correctProductOptions(
  tx: Transaction,
  productId: string,
  asked: readonly OptionCorrection[],
): Promise<{ readonly ok: true } | NotUsable | CombinationTaken> {
  const existing = await readProductOptions(tx, productId);
  const known = new Set(existing.map((one) => one.id));

  const unknown = asked.flatMap((one) =>
    one.id !== undefined && !known.has(one.id) ? [one.id] : [],
  );
  if (unknown.length > 0) {
    return notUsable(
      `\`options\` names ${quoted(unknown)}, which this Product does not have — it ${
        existing.length === 0
          ? "declares no options at all"
          : `declares ${quoted(existing.map((one) => one.name))}`
      }. Leave an \`id\` out entirely to declare a new option.`,
    );
  }

  const kept = new Set(asked.flatMap((one) => (one.id === undefined ? [] : [one.id])));
  const removed = existing.filter((one) => !kept.has(one.id));

  // **The second judgement, and still before the first write** (#277). Removing an option takes
  // every Variant's answer to it, and two Variants that differed only there answer one
  // combination afterwards — a Product whose detail payload a storefront cannot choose from. It
  // is refused rather than allowed-and-reported because the repair is a control a Merchant has:
  // correct or delete one of the two. Adding an option cannot reach this, which is #253's
  // decision kept rather than reopened — see the head of this module.
  const collided = await correctionWouldCollide(tx, productId, asked, removed);
  if (collided) return collided;

  if (removed.length > 0) {
    // The values every Variant gave for them go too, by the cascade on `option_id`: an answer to
    // a question this Product no longer asks is not a fact about anything.
    await tx.delete(productOption).where(
      and(
        eq(productOption.productId, productId),
        inArray(
          productOption.id,
          removed.map((one) => one.id),
        ),
      ),
    );
  }

  // One statement per entry, in the list's own order, and a `position` written from that order
  // rather than from what was there. A rename to a name a *different* option is on its way out
  // of is why there is no unique index on `(product_id, name)` — see `db/schema.ts`.
  for (const [position, one] of asked.entries()) {
    if (one.id === undefined) {
      await tx.insert(productOption).values({ productId, name: one.name, position });
      continue;
    }

    await tx
      .update(productOption)
      .set({ name: one.name, position })
      // Scoped to the Product as well as to the row, so an `id` belonging to somebody else's
      // Product could not be corrected through this one even if the check above were removed.
      .where(and(eq(productOption.id, one.id), eq(productOption.productId, productId)));
  }

  return { ok: true };
}

/** One Variant's answers, as a write is given them. */
export type VariantAnswers = {
  readonly variantId: string;
  readonly values: readonly VariantOptionValue[];
};

/**
 * Writes the values of however many Variants, in **one** statement.
 *
 * Many rather than one because a create writes every Variant of a Product at once, and a
 * statement per Variant would be a loop over a list the caller already has whole — the same
 * judgement `lockVariants` makes about asking for several rows at a time.
 *
 * `options` is the Product's declared list, which is where each name's identifier comes from.
 * The caller has already held the values to exactly those names, so a name with no option here
 * is unreachable — and it is skipped rather than thrown at, because a `null` foreign key is not
 * a thing this function should be able to write on any path.
 */
export async function writeVariantOptionValues(
  tx: Transaction,
  answers: readonly VariantAnswers[],
  options: readonly ProductOption[],
): Promise<void> {
  const idByName = new Map(options.map((one) => [one.name, one.id]));
  const rows = answers.flatMap((answer) =>
    answer.values.flatMap((one) => {
      const optionId = idByName.get(one.name);
      return optionId === undefined
        ? []
        : [{ variantId: answer.variantId, optionId, value: one.value }];
    }),
  );
  if (rows.length === 0) return;

  await tx.insert(variantOptionValue).values(rows);
}

/**
 * Replaces one Variant's values with the ones it was given.
 *
 * **Delete then insert, never an upsert per value.** The set is the fact — a Variant answers
 * exactly its Product's options — so writing it as a whole is what makes an option dropped from
 * the request actually gone, and it is what lets the unique index on `(variant_id, option_id)`
 * stand: no row on its way in can collide with one on its way out. A Variant being *created* has
 * nothing to delete, which is why the insert above is reached directly from there.
 */
export async function replaceVariantOptionValues(
  tx: Transaction,
  variantId: string,
  values: readonly VariantOptionValue[],
  options: readonly ProductOption[],
): Promise<void> {
  await tx.delete(variantOptionValue).where(eq(variantOptionValue.variantId, variantId));
  await writeVariantOptionValues(tx, [{ variantId, values }], options);
}

/** What a list naming one option twice is told, wherever it is said. */
function namedTwice(name: string): string {
  return `\`options\` names ${JSON.stringify(name)} twice. An option is one question, so a Product asks it once and a Variant answers it once.`;
}

/** `"Size" and "Colour"`, in a sentence. */
function quoted(names: readonly string[]): string {
  return listed(names.map((name) => JSON.stringify(name)));
}

/** The same list-making, for the parts that carry their own quotation marks. */
function listed(parts: readonly string[]): string {
  const last = parts.at(-1);
  return parts.length <= 1
    ? (last ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${last}`;
}
