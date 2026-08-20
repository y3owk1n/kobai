import type { KobaiClient } from "@kobai/client";
import { messageOf, Refused } from "@/lib/refusal";

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
 *
 * **A secret key is never stored here or anywhere else, and that is the rule this module's
 * existence protects** (ADR-0055, ADR-0081). The Playground lets a Developer paste one for a
 * single request; it is held in that screen's own memory, never in `sessionStorage`, never in
 * the address, and gone on reload. The Admin never *mints* and never *stores* a secret key.
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

/**
 * Something kobai would not do — the mint, or whatever the caller then asked with the key.
 *
 * It extends {@link Refused} rather than `Error` so that the refusal **body travels**, which is
 * the whole reason that class carries one: a screen that has to narrow still can, and
 * `problemOf` reads it like any other refusal. What it adds is the sentence to show when kobai
 * sent no prose of its own — the mint and the price want different ones, and the revoked-key
 * case has no body at all, because from kobai's side that was an ordinary `api-key-revoked` and
 * the sentence a Merchant needs is about this browser rather than about that request.
 */
export class PreviewRefused extends Refused {
  constructor(refusal: unknown, fallback: string) {
    super(refusal);
    this.name = "PreviewRefused";
    this.message = messageOf(refusal, fallback);
  }
}

/**
 * The publishable key this browser session holds, minting one where it holds none.
 *
 * **There is one of these, and that is a decision rather than tidiness** (ADR-0081). The
 * storefront price preview asks it so it can *be* a storefront, and the Playground asks it so a
 * Developer can send a request as one — and two self-minting mechanisms would double an
 * accumulation this module already apologises for, and would put two lines meaning "the Admin
 * itself" in a Merchant's API keys list where they want one.
 *
 * Publishable rather than secret on purpose: `kobai_pk_` is the kind that is safe in a browser,
 * and a secret key here would be the exact mistake the two prefixes exist to make visible.
 *
 * It is asked at the moment a key is needed and never on a mount, because asking **costs a
 * key** — which is also why both callers reach for it from a mutation rather than from a query.
 */
export async function heldPreviewKey(client: KobaiClient): Promise<string> {
  const held = readPreviewKey();
  if (held !== null) return held;

  const { data, error } = await client.POST("/admin/api-keys", {
    body: { name: PREVIEW_KEY_NAME, kind: "publishable" },
  });
  if (!data) {
    throw new PreviewRefused(error, "A publishable key could not be minted.");
  }

  writePreviewKey(data.key);
  return data.key;
}
