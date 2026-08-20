import type { ListboxOption } from "@/components/listbox-field";

/**
 * ISO 4217, as the browser already holds it (#300).
 *
 * **This is the one vocabulary in the Admin that is neither kobai's nor written down here.**
 * `lib/store.ts`, `lib/markets.ts` and `lib/collections.ts` each read a set kobai names, because
 * what a deployment has enabled, sells in or files things under is a deployment's decision
 * (ADR-0063, ADR-0067). Which three-letter codes exist is nobody's decision: it is a standard
 * that changes without us, kobai holds no table of it either, and `Intl` is already shipping
 * one in every browser this Admin runs in. So a route for it would be Core promising a
 * vocabulary it does not own, and a `const` here would be a copy of the standard going stale
 * from the day it was typed. A seeded table with a list route in front of it was weighed and
 * refused for both of those reasons and a third: `core_store_currency` has a length check and no
 * foreign key on purpose, so a table would close a vocabulary Core deliberately left open.
 *
 * **It is a vocabulary and never the boundary**, and two things follow that a reader should not
 * have to infer. `core_store_currency` takes any three-character code and every refusal it has
 * stays exactly as it is. And because this screen is the only way a Merchant reaches that route,
 * the picker over this list **suggests rather than fences**: a code this runtime does not list is
 * still typed in and still accepted, or a browser's gap in `Intl` would become kobai's. What this
 * removes is a Merchant finding out from a refusal that `RM`, `myr` or the wrong three letters is
 * not what they meant.
 */

/**
 * Read once and kept, because it is the same answer every time.
 *
 * The list runs to a few hundred entries — how many is the runtime's own business, and the
 * headless Chromium the gate drives answers rather fewer than a desktop one — and each label is
 * a call into `Intl`. Nothing can change it while the tab is open, a browser's locale data being
 * fixed at load, so the work belongs to the first field that asks rather than to every render of
 * it. It is deliberately **not** done at module load: this file is imported by a screen, and a
 * Merchant who never opens that card should not pay for it.
 *
 * It is also what makes the list safe to hand a `Combobox` as `items`: the identity is stable
 * across renders, which is what that component compares a chosen value against.
 *
 * `undefined` is "nobody has asked yet" and `null` is "this runtime does not list them", which
 * is why the two are told apart here rather than collapsed into one falsy check.
 */
let cached: readonly ListboxOption[] | null | undefined;

/** "Nobody has asked yet", told apart from an `undefined` that is itself an answer. */
const UNASKED = Symbol("unasked");

/**
 * One code and how to read it — `{ value: "MYR", label: "MYR — Malaysian Ringgit" }` — or `null`
 * where this runtime cannot say.
 *
 * A caller that gets `null` owes its Merchant the control they had before rather than an empty
 * menu: `Intl.supportedValuesOf` is a 2022 addition, and a browser without it can still enable a
 * currency by typing its code, which is what kobai's own route takes.
 */
export function isoCurrencies(): readonly ListboxOption[] | null {
  if (cached === undefined) cached = read();
  return cached;
}

function read(): readonly ListboxOption[] | null {
  // The guard is on the function rather than in a `try`, because "this runtime does not list
  // currencies" is a state to render differently rather than a failure to swallow.
  if (typeof Intl.supportedValuesOf !== "function") return null;

  return Intl.supportedValuesOf("currency").map((code) => ({
    value: code,
    label: currencyLabel(code),
  }));
}

/**
 * One code as a Merchant reads it — `MYR — Malaysian Ringgit`, or `MYR` where this runtime has
 * no name for it.
 *
 * **This is the one place a currency is named, and every picker in the Admin goes through it**
 * (#300). `lib/store.ts` labels the Store's *enabled* set with it, which is what the Region
 * screen, the New Region form and the Price editor each render — so no screen shows a bare code
 * where another shows a named one, and a Merchant can type `ringgit` on any of them.
 *
 * **Naming a code is not the same question as which codes exist.** Which currencies this Store
 * prices in is a deployment's decision and stays kobai's answer, read through `lib/store.ts`;
 * this only says how to read one of them, which is the browser's business and nobody's decision.
 *
 * The code leads because it is what kobai stores, what every Price is denominated in, and what a
 * Merchant who already knows the answer will type.
 */
export function currencyLabel(code: string): string {
  const name = nameOf(code);
  return name === undefined || name === code ? code : `${code} — ${name}`;
}

/**
 * How this runtime says a currency's name, or nothing where it cannot — asked for once.
 *
 * The runtime's own locale, like `lib/money.ts`'s formatter and for the same reason: the Admin
 * has no locale of its own to impose, and the **code** is what a Merchant is choosing either
 * way. A runtime with no display names at all still gets a list of codes, which is the point —
 * a menu of unlabelled codes is better than a text box, and an entry reading `undefined` is
 * worse than both.
 *
 * Held across calls because there are a few hundred labels behind one open list, and
 * {@link UNASKED} is what tells "not built yet" from the `undefined` that means "built, and this
 * runtime has none".
 */
let held: Intl.DisplayNames | undefined | typeof UNASKED = UNASKED;

function displayNames(): Intl.DisplayNames | undefined {
  if (held === UNASKED) {
    try {
      held = new Intl.DisplayNames(undefined, { type: "currency" });
    } catch {
      held = undefined;
    }
  }
  return held;
}

/**
 * What this runtime calls the code, or nothing.
 *
 * `Intl.DisplayNames` falls back to the code it was given for a currency it does not know, so
 * the two being equal — which {@link currencyLabel} reads as "no name" — is not a failure, and
 * `MYR — MYR` would be the `undefined` row wearing a different hat.
 */
function nameOf(code: string): string | undefined {
  try {
    return displayNames()?.of(code);
  } catch {
    // `of` throws on a code it considers malformed rather than answering. Nothing in
    // `supportedValuesOf` should reach that, and a label is not worth a blank screen if one does.
    return undefined;
  }
}
