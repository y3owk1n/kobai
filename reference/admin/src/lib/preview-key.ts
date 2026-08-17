/**
 * The publishable API key the Admin pretends to be a storefront with.
 *
 * A key value is shown once, at creation, and never again — only a digest is stored — so
 * something has to hold it between the screen that mints it and the screen that uses it. It
 * is kept in `sessionStorage`, and only a **publishable** key is ever put there: `kobai_pk_`
 * means "safe in a browser", which is exactly the claim being made by storing it.
 *
 * The Merchant's session is *not* stored anywhere, here or elsewhere. It is an httpOnly
 * cookie the browser holds and no script can read (ADR-0032), which is the difference this
 * file exists to keep visible: the Admin carries a storefront's credential on purpose and
 * carries its own by not carrying it at all.
 */
const PREVIEW_KEY = "kobai.admin.storefront-preview-key";

/**
 * The `name` every key the Admin mints for itself carries.
 *
 * One name, so a Merchant looking at the API keys screen can tell the Admin's own keys from
 * the ones they minted for a real storefront — and revoke them. They do accumulate: a key's
 * value cannot be recovered, so a browser session with no stored key has no choice but to
 * mint a fresh one rather than reuse a live key it cannot read.
 */
export const PREVIEW_KEY_NAME = "Admin storefront preview";

export function readPreviewKey(): string | null {
  return window.sessionStorage.getItem(PREVIEW_KEY);
}

export function writePreviewKey(key: string): void {
  window.sessionStorage.setItem(PREVIEW_KEY, key);
}

export function clearPreviewKey(): void {
  window.sessionStorage.removeItem(PREVIEW_KEY);
}
