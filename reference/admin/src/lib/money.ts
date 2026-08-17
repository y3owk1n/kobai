/**
 * An amount, as a person reads it.
 *
 * kobai stores minor units — 1250 is USD 12.50 — and how many minor units make one major
 * unit is a property of the currency, not a constant. `Intl` already knows, so it is asked
 * rather than assumed: a Store pricing in JPY would otherwise show every price a hundred
 * times too small, silently.
 */
export function formatAmount(amount: number, currency: string): string {
  const format = new Intl.NumberFormat(undefined, { style: "currency", currency });
  const minorDigits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(amount / 10 ** minorDigits);
}
