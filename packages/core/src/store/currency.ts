import { asc, eq, inArray } from "drizzle-orm";
import type { Queryable, Transaction } from "../db/client.ts";
import { region, storeCurrency } from "../db/schema.ts";
import { isJsonObject, trimmed } from "../input.ts";
import { type NotUsable, notUsable } from "../patch.ts";

/**
 * The currencies this Store may price in — reading the set, and replacing it (#291, ADR-0074).
 *
 * **The Store enumerates and a Region selects.** ADR-0074 settled that shape and this module is
 * the enumerating half: `core_store_currency` is the vocabulary a Price may be denominated in,
 * and `store/region.ts` is where one of them is chosen for a geography. Store-only was rejected
 * there because it discards the entity tax and shipping hang off; Region-only because it makes a
 * currency unusable until somebody defines a geography.
 *
 * Three things here are decisions rather than implementation:
 *
 * **The set is a field on the Store rather than a list route of its own.** It is read by
 * `GET /admin/store` and written by `PATCH /admin/store`, which is exactly the pair the ticket
 * asks for — `store:read` and `store:write` — and it means there is no plural route that would
 * have to page under ADR-0064. That boundary is worth stating, because the answer is *not*
 * ADR-0067's: a Merchant can enable a currency over HTTP while somebody is reading, so a
 * standalone list of them would have had to page like every other list over a table. It is a
 * field of one record instead, the way a Product's `collections` is.
 *
 * **It is the whole set on the way in**, which is `media`'s and `collections`' bargain one noun
 * along: a list of edits leaves no way to say *and this one is gone*, and the two routes it
 * would take are two permanent paths (ADR-0060) saying what one field says. The order carries
 * no meaning — this is a set — so what a read answers with is by code.
 *
 * **The Store's default cannot be disabled**, and {@link DEFAULT_CURRENCY_MUST_BE_ENABLED} is
 * where that is refused. ADR-0074 narrowed ADR-0065's argument to exactly this: the default is
 * what an *unconstrained* Price is denominated in, so a Store that stopped enabling it would be
 * quoting rows in a currency it no longer prices in — the state a Price naming a currency the
 * Store has not enabled is refused to prevent, arriving wholesale from the other end.
 */

/** A currency this Store may price in. An object rather than a bare code — see below. */
export type EnabledCurrency = {
  /** ISO 4217, upper case. */
  readonly code: string;
};

/** Refused because the set would have left out the code every unconstrained Price carries. */
export const DEFAULT_CURRENCY_MUST_BE_ENABLED = "default-currency-must-be-enabled";

/** Refused because a Region selects a currency the set would have taken away. */
export const CURRENCY_IN_USE = "currency-in-use";

/**
 * How a set of currencies is refused, past the request's own `invalid`.
 *
 * Two words, and they are two facts: one is about the Store's own default and one is about a
 * Region somebody made. Sharing a word would tell a client the repairs are the same, and they
 * are opposite — the first is never repairable at all and the second is repaired by changing or
 * deleting the Region it names.
 */
export type CurrencySetRefusal = NotUsable<
  typeof DEFAULT_CURRENCY_MUST_BE_ENABLED | typeof CURRENCY_IN_USE
>;

/**
 * The codes this Store has enabled, by code.
 *
 * `Queryable`, so the write below can read the set back inside its own transaction — the same
 * reason `readStore` takes one.
 */
export async function readEnabledCurrencies(
  db: Queryable,
): Promise<readonly EnabledCurrency[]> {
  const rows = await db
    .select({ code: storeCurrency.code })
    .from(storeCurrency)
    // By code, because a set has no order of its own and this is the only column there is.
    .orderBy(asc(storeCurrency.code));
  return rows;
}

/**
 * The `currencies` a body asked for, upper-cased and deduplicated — or why it is unusable.
 *
 * **Read case-insensitively**, exactly as `PATCH /admin/store`'s `defaultCurrency` is and for
 * its reason: `usd` and `USD` are one code, and `setPrice` already upper-cases what it is
 * given. The check on the column is `char_length = 3`, so the shape is judged here rather than
 * against a table of the world's currencies that would go stale.
 *
 * A code named twice is **not** refused: a set is a set, and asking for `["USD", "usd"]` is
 * asking for one currency in two spellings rather than a body conflicting with itself. That is
 * the opposite call from `collections`, and the difference is that a Collection is named by an
 * identifier a Merchant copied, where a currency code is typed.
 */
export function parseEnabledCurrencies(value: unknown): CurrenciesAsked {
  if (!Array.isArray(value)) {
    return notUsable(
      '`currencies` must be the complete list of the currencies this Store may price in — e.g. [{ "code": "USD" }, { "code": "MYR" }]. It replaces the set rather than adding to it, and the Store\'s default currency has to be among them.',
    );
  }

  const codes: string[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      return notUsable(
        'Each entry in `currencies` must be an object with a `code` — e.g. { "code": "USD" }.',
      );
    }

    const code = (trimmed(entry.code) ?? "").toUpperCase();
    if (code.length !== 3) {
      return notUsable(
        `Each entry in \`currencies\` must carry an ISO 4217 code — three letters, e.g. "USD". ${JSON.stringify(entry.code)} is not one.`,
      );
    }
    if (!codes.includes(code)) codes.push(code);
  }

  return { ok: true, value: codes };
}

type CurrenciesAsked = { readonly ok: true; readonly value: string[] } | NotUsable;

/**
 * Replaces the enabled set with exactly these codes, or says why it will not.
 *
 * **Both refusals are asked before the first write**, for the reason `collectionsThisStoreDoesNotHave`
 * is: a refusal returned from inside a transaction commits it, so a set judged after the rows
 * had been rewritten would answer 422 over a Store whose currencies really had changed.
 *
 * **The Region check is a read followed by a write, and the foreign key is what makes that
 * safe** rather than the read. `core_region.currency` is `on delete restrict`, so a Region
 * created in the window between the two takes the delete down as the 500 it is instead of
 * leaving a Region denominated in a currency this Store no longer prices in. The read exists to
 * *name* the Regions, which is the one thing the constraint cannot do.
 *
 * `delete` then `insert`, never a reconciliation: the list is the fact, so writing it whole is
 * what makes a code left out actually a currency taken away — and nothing on its way in can
 * collide with a row on its way out.
 */
export async function setEnabledCurrencies(
  tx: Transaction,
  defaultCurrency: string,
  codes: readonly string[],
): Promise<CurrencySetRefusal | undefined> {
  if (!codes.includes(defaultCurrency)) {
    return {
      ok: false,
      reason: DEFAULT_CURRENCY_MUST_BE_ENABLED,
      detail: `This Store prices in ${defaultCurrency}, so it has to be one of the currencies it may price in. A Price carrying no Region and no Channel is denominated in the Store's default currency, so disabling it would leave those amounts in a currency this Store does not price in. \`currencies\` must include ${JSON.stringify(defaultCurrency)}.`,
    };
  }

  const removed = (await readEnabledCurrencies(tx))
    .map((one) => one.code)
    .filter((code) => !codes.includes(code));

  if (removed.length > 0) {
    const selecting = await tx
      .select({ name: region.name, currency: region.currency })
      .from(region)
      .where(inArray(region.currency, removed))
      .orderBy(asc(region.name));

    if (selecting.length > 0) {
      const named = selecting
        .map((one) => `${JSON.stringify(one.name)} (${one.currency})`)
        .join(", ");
      return {
        ok: false,
        reason: CURRENCY_IN_USE,
        detail: `${named} ${selecting.length === 1 ? "selects a currency" : "select currencies"} this set would take away. A Region prices in one of the currencies this Store has enabled, so move ${selecting.length === 1 ? "it" : "them"} onto another currency — \`PATCH /admin/regions/{id}\` — or delete ${selecting.length === 1 ? "it" : "them"}, and send this again.`,
      };
    }

    await tx.delete(storeCurrency).where(inArray(storeCurrency.code, removed));
  }

  const enabled = new Set((await readEnabledCurrencies(tx)).map((one) => one.code));
  const added = codes.filter((code) => !enabled.has(code));
  if (added.length > 0) {
    await tx.insert(storeCurrency).values(added.map((code) => ({ code })));
  }

  return undefined;
}

/**
 * Whether this Store has enabled a code — the question a Region's create and correction ask.
 *
 * A read rather than the foreign key's own answer, because the key can only say that *a*
 * reference was bad and this can say which code and what to do about it. A currency disabled in
 * the window between the two travels as the 500 it is, which is the same bargain
 * `collectionsThisStoreDoesNotHave` takes and a narrower window than it.
 */
export async function currencyIsEnabled(db: Queryable, code: string): Promise<boolean> {
  const [found] = await db
    .select({ code: storeCurrency.code })
    .from(storeCurrency)
    .where(eq(storeCurrency.code, code))
    .limit(1);
  return found !== undefined;
}
