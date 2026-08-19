import { consoleLogger, type Database, type Logger } from "@kobai/core";
import {
  paymentIntentIdOfEvent,
  STRIPE_PAYMENT_INTENT_KEY,
  type StripePaymentProvider,
} from "@kobai/plugin-stripe";
import type { RedirectPayments } from "./redirect.ts";

/**
 * **Stripe, as this deployment's bank** — the whole of what wiring `@kobai/plugin-stripe` into
 * a Project costs (ADR-0070).
 *
 * Two things live here and they are deliberately separate. {@link stripeConfiguration} decides
 * *whether* this deployment takes payments a Shopper completes at their bank, from its own
 * environment and nothing else; {@link stripeRedirectPayments} is the adapter that turns the
 * Plugin into the four calls {@link ./redirect.ts | this Project's routes} ask of a bank. A
 * deployment given no Stripe settings gets neither, keeps `src/payments/manual.ts`, and serves
 * everything it served before — misconfiguring payments must not take a Store down (ADR-0053).
 *
 * **This is a Project's file, not kobai's**, which is the point of it. `PaymentProvider` is a
 * named interface Core implements nowhere, and the two implementations this repository has now
 * come from the two places they can come from: this Project's own source (`manual.ts`) and a
 * published package (`@kobai/plugin-stripe`). What is *here* is only the joining up — a page
 * to send a Shopper to, a handle on this Project's database for the Plugin's own table — and
 * that is the part no package could have written for a deployment it has never seen.
 */

/** The three settings a deployment gives Stripe, as `.env.example` documents them. */
export const STRIPE_VARIABLES = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PAYMENT_PAGE_URL",
] as const;

/** As much of a deployment's environment as payments read. */
export type StripeEnvironment = Partial<
  Record<(typeof STRIPE_VARIABLES)[number], string>
>;

/** What a deployment that takes payments at a bank has been given. */
export type StripeConfiguration = {
  /** The Stripe **secret** key — `sk_live_…` or `sk_test_…`, never a publishable one. */
  readonly secretKey: string;
  /** What `/webhooks/stripe` verifies every request against — `whsec_…`. */
  readonly webhookSecret: string;
  /**
   * The storefront's own page that finishes the payment.
   *
   * Stripe's redirect is driven in the browser rather than by a URL a server can be handed:
   * Elements takes a client secret, offers whatever the currency allows, and sends the Shopper
   * to their bank itself. So what this Project answers a storefront with is that page, with
   * the client secret on it — which is a page only the deployment knows the address of, and
   * why this is a setting rather than something kobai could work out.
   */
  readonly paymentPageUrl: string;
};

/**
 * Whether this deployment takes payments at a bank, and what with — `null` when it does not.
 *
 * **All three or none**, and a deployment that set some of them is told which are missing and
 * then treated as one that set none. Two of the three are useless alone — a secret key with no
 * page to send a Shopper to starts payments nobody can complete, a page with no webhook secret
 * settles only the Shoppers who come back — so wiring a half-configured Stripe would be
 * offering a Store a payment method that works for some purchases. It says so and carries on
 * serving, which is the same judgement `KOBAI_INITIAL_MERCHANT_*` already gets: a deployment
 * that cannot yet be bought from is still a Store worth reading (ADR-0048, ADR-0053).
 *
 * The environment is passed in rather than read here, so that both branches are ordinary to
 * test and neither depends on what the machine running the suite happens to export.
 */
export function stripeConfiguration(
  environment: StripeEnvironment,
  logger: Logger = consoleLogger,
): StripeConfiguration | null {
  // An exported-but-empty variable is the same fact as an unset one — `compose.yaml` forwards
  // bare names, and a blank secret key would wire a provider that authenticates against
  // nothing and declines every purchase in the Store.
  const given = STRIPE_VARIABLES.filter((name) => (environment[name] ?? "") !== "");
  if (given.length === 0) return null;

  if (given.length < STRIPE_VARIABLES.length) {
    logger.error("this deployment's payments are half configured", {
      reason:
        "some of Stripe's settings are here and some are not, so no payment could be completed. This Store is settling out of band instead — see `payments` in kobai.config.ts",
      missing: STRIPE_VARIABLES.filter((name) => !given.includes(name)),
    });
    return null;
  }

  return {
    secretKey: environment.STRIPE_SECRET_KEY ?? "",
    webhookSecret: environment.STRIPE_WEBHOOK_SECRET ?? "",
    paymentPageUrl: environment.STRIPE_PAYMENT_PAGE_URL ?? "",
  };
}

/** What the adapter needs that the Plugin cannot know. */
export type StripeRedirectPaymentOptions = {
  /** The Plugin's provider — the same object `kobai.config.ts` gives Core as its `payments.provider`. */
  readonly stripe: StripePaymentProvider;
  /**
   * This Project's own database handle, for the Plugin's table of refunds it made for
   * payments that produced no Order (ADR-0004).
   *
   * A closure here rather than an argument the routes carry: the handle does not exist until
   * `createKobai` has run, and `kobai.config.ts` is read before that.
   */
  readonly db: Database;
  readonly paymentPageUrl: string;
};

/**
 * `@kobai/plugin-stripe` as {@link RedirectPayments} — the four calls, and nothing else.
 *
 * Each is one line because the Plugin already answers the hard half; what this adds is the two
 * things a package cannot know about a deployment. The Cart and the open context are not
 * carried here at all — they are read back off the payment by `paymentOf`, which is what makes
 * the Shopper's return and Stripe's webhook one request under one `Idempotency-Key`.
 */
export function stripeRedirectPayments({
  stripe,
  db,
  paymentPageUrl,
}: StripeRedirectPaymentOptions): RedirectPayments {
  return {
    // The Plugin's key, not this Project's: kobai hands the open context to a Payment Provider
    // verbatim, and `stripePaymentIntent` is the one key `@kobai/plugin-stripe`'s `charge`
    // reads out of it.
    referenceKey: STRIPE_PAYMENT_INTENT_KEY,

    startPayment: async ({ cartId, metadata, amount, currency }) => {
      const started = await stripe.startPayment({ cartId, metadata, amount, currency });
      return {
        reference: started.reference,
        redirectUrl: paymentPageFor(paymentPageUrl, started.clientSecret),
      };
    },

    paymentOf: (reference) => stripe.paymentOf(reference),

    referenceOfCallback: (body) => paymentIntentIdOfEvent(body),

    refundUnplacedPayment: async ({ reference, cartId, refusal }) => {
      // The row the Plugin writes is a Merchant's account of money that arrived and produced
      // no Order; this Project needs nothing back from it, so the row is not passed on.
      await stripe.refundUnplacedPayment({ db, reference, cartId, refusal });
    },
  };
}

/**
 * Where the Shopper goes to finish paying — the storefront's page, carrying the client secret.
 *
 * `payment_intent_client_secret` is Stripe's own name for it: it is the parameter Stripe itself
 * appends when it sends a Shopper back from their bank, so a page that can read one can read
 * both and a storefront needs no second convention from this Project.
 */
function paymentPageFor(paymentPageUrl: string, clientSecret: string): string {
  const page = new URL(paymentPageUrl);
  page.searchParams.set("payment_intent_client_secret", clientSecret);
  return page.href;
}
