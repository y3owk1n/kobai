import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Queryable, Transaction } from "../db/client.ts";
import { productOption, variantOptionValue } from "../db/schema.ts";
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
 * **Two Variants may answer the same combination, and nothing here refuses it — which is a
 * known gap rather than a decision.** The unique index is `(variant_id, option_id)`, so it makes
 * a Variant's answer to one option single and says nothing about two Variants agreeing on every
 * option. A Store that reaches that state has a Product detail payload a storefront cannot
 * choose from — `Size: S, Colour: Red` maps to two SKUs and the picker takes whichever came
 * first — which is exactly the claim the rest of this file rests on. Closing it is a rule about
 * a Variant against its *siblings* rather than against its Product, so it wants its own refusal
 * and its own place to be enforced from at all three write paths; #253 did not ask for it, and
 * it is recorded here rather than left to be rediscovered from a storefront.
 *
 * **A Product's own list is corrected freely and its Variants are not re-judged for it.** That
 * asymmetry is the decision that keeps the repair reachable: declaring a third option on a
 * Product that already has Variants would otherwise be refused for every Variant at once, with
 * the only remedy being to delete the Product and build it again (ADR-0059's rule, and
 * `the-http-surface.md`'s — a refusal whose advice names no reachable control is a finding
 * rather than something to word around). So adding an option leaves the Variants under it
 * unanswered until each is corrected, exactly as a Variant with no Price is unsellable until
 * one is set, and removing an option takes every Variant's answer to it with it by cascade.
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
 * Serialises every correction of one Product's options, for the length of the transaction.
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
 * throwing to unwind it.
 *
 * **The caller has taken {@link lockProductOptions} and then `lockProduct`**, in that order and
 * before the read below. The first is what makes this read-then-write one operation; the second
 * is only existence, so the rows written here cannot reference a Product that has gone.
 */
export async function correctProductOptions(
  tx: Transaction,
  productId: string,
  asked: readonly OptionCorrection[],
): Promise<{ readonly ok: true } | NotUsable> {
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
  const removed = existing.filter((one) => !kept.has(one.id)).map((one) => one.id);
  if (removed.length > 0) {
    // The values every Variant gave for them go too, by the cascade on `option_id`: an answer to
    // a question this Product no longer asks is not a fact about anything.
    await tx
      .delete(productOption)
      .where(
        and(eq(productOption.productId, productId), inArray(productOption.id, removed)),
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
  const written = names.map((name) => JSON.stringify(name));
  const last = written.at(-1);
  return written.length <= 1
    ? (last ?? "")
    : `${written.slice(0, -1).join(", ")} and ${last}`;
}
