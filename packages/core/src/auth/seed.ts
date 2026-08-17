import type { Database } from "../db/client.ts";
import type { MerchantIdentity } from "./identity.ts";
import { createFirstMerchant, hasAnyMerchant } from "./merchant.ts";

/**
 * The first Merchant, seeded at boot from what the deployment was configured with.
 *
 * Core has **no unauthenticated write path** (#25). `POST /admin/merchants` is guarded by
 * `merchant:write` like every other admin route, which leaves a fresh deployment with a
 * question it cannot answer over HTTP: nobody holds the permission, so nobody can create the
 * Merchant who would. The answer is that the deployment is *told* who its first Merchant is,
 * at boot, beside the migrations — the same place, and by the same reasoning, as everything
 * else a deployment has to be given before it can serve.
 *
 * The alternative was the route answering an anonymous request while no Merchant existed. It
 * was race-safe and still wrong: whoever reached a fresh deployment first owned the Store,
 * and an internet-reachable container is reached by strangers within minutes.
 */

/**
 * Credentials as a deployment supplies them — possibly absent, possibly wrong.
 *
 * Typed as optional strings rather than as a validated pair, because that is the shape the
 * answer actually arrives in: `process.env.X` is `string | undefined`, and every failure this
 * module has to tell apart is a failure of what was configured.
 */
export type InitialMerchantCredentials = {
  readonly email?: string | undefined;
  readonly password?: string | undefined;
};

/**
 * What a boot's seeding did, in the four outcomes a deployment has to be able to tell apart.
 *
 * They are four rather than a boolean for the reason `/health` reports a migration state
 * rather than "up": a deployment that was never configured, one whose configuration is
 * unusable, one that has just been given its Merchant and one that already had one are four
 * different things for an operator to do next, and collapsing them would mean the commonest
 * of them — a second boot, which must change nothing — looked exactly like a failure.
 */
export type InitialMerchantSeed =
  /** Created by this boot. It exists now and did not before. */
  | { readonly status: "seeded"; readonly merchant: MerchantIdentity }
  /** A Merchant already existed, so nothing was created. Every boot after the first. */
  | { readonly status: "already-present" }
  /** Nothing was configured. The deployment has no Merchant and nobody can sign in. */
  | { readonly status: "not-configured" }
  /** Something was configured and cannot be used — half of a pair, or a value Core refuses. */
  | { readonly status: "not-usable"; readonly detail: string };

/**
 * Seeds the first Merchant, and is safe to call on every boot.
 *
 * **Idempotent in two places, deliberately.** The check here answers the ordinary second
 * boot without touching a lock; the re-check inside {@link createFirstMerchant}'s transaction
 * answers the case this one cannot — two processes booting against one database at the same
 * moment, where both look, both find nothing, and one has to lose. A deployment that already
 * holds a Merchant is left exactly as it was found, whatever it was configured with, so a
 * credential rotated in the environment does not silently create a second account and does
 * not fail a boot that would otherwise have been fine.
 */
export async function seedInitialMerchant(
  db: Database,
  credentials: InitialMerchantCredentials,
): Promise<InitialMerchantSeed> {
  if (await hasAnyMerchant(db)) return { status: "already-present" };

  const email = configured(credentials.email) ? credentials.email : undefined;
  const password = configured(credentials.password) ? credentials.password : undefined;

  if (email === undefined && password === undefined) return { status: "not-configured" };
  if (email === undefined || password === undefined) {
    // Half a pair is not the same answer as none of one: it is somebody who meant to
    // configure this and stopped, so it is reported as a mistake rather than as a choice.
    return {
      status: "not-usable",
      detail: `The ${email === undefined ? "email address" : "password"} was not configured. The first Merchant needs both.`,
    };
  }

  const created = await createFirstMerchant(db, { email, password });
  if (created.ok) {
    // Narrowed to the identity rather than passed through whole: a seeded Merchant always
    // holds `owner`, so the Role carries no information here, and the one caller logs this.
    const { id, email: address } = created.merchant;
    return { status: "seeded", merchant: { id, email: address } };
  }

  // The loser of a race between two booting processes, which is the same answer the check
  // above gives the second boot: somebody else got there, and there is nothing left to do.
  if (created.reason === "already-present") return { status: "already-present" };

  // Everything else is the configuration's fault, and the detail says which part. The
  // configured values are deliberately *not* echoed — see the boot log's own reasoning in
  // `kobai.ts`.
  return { status: "not-usable", detail: created.detail };
}

/**
 * Whether a value was configured at all: `KOBAI_…=` in a compose file is an absence, not an
 * empty credential.
 *
 * It judges by the trimmed value and hands back the untrimmed one, because a password's
 * surrounding whitespace is part of the password — trimming it here would make the
 * credential a Merchant signs in with differ from the one their operator set.
 */
function configured(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}
