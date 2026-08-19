import type { PaymentOutcome, PaymentProvider, PaymentRequest } from "@kobai/core";
import {
  callStripe,
  integerOrUndefined,
  type StripeOptions,
  type StripeResult,
  stringOrUndefined,
} from "./api.ts";
import type { StripeUnplacedRefundRow } from "./db/schema.ts";
import {
  refundUnplacedPayment,
  type UnplacedPaymentRefund,
} from "./refund-unplaced-payment.ts";

/**
 * The key the PaymentIntent's id travels under on `POST /store/orders`.
 *
 * ADR-0013's open context: everything the caller sent that Core does not model reaches a
 * provider verbatim in {@link PaymentRequest.metadata}, and this is the one key this Plugin
 * reads out of it. Both callers send it — the Shopper's returning browser and the Project's
 * webhook route — because both are making the same kobai call (ADR-0070).
 */
export const STRIPE_PAYMENT_INTENT_KEY = "stripePaymentIntent";

/**
 * The key the Cart identifier travels under in a PaymentIntent's `metadata`.
 *
 * Stripe hands the whole intent — metadata included — to a webhook, and the Cart is the only
 * thing that says which purchase a payment was for. So this is what turns
 * `payment_intent.succeeded` into `POST /store/orders` for a Cart, and it is what makes the
 * Shopper's return and the webhook the *same* kobai call rather than two designs (ADR-0070).
 */
export const STRIPE_CART_ID_KEY = "kobaiCartId";

/**
 * The Cart a PaymentIntent was created for, or `null` for one this Plugin did not start.
 *
 * What a Project's webhook route reaches for. Stripe delivers `payment_intent.succeeded` with
 * the intent as `data.object` and nothing else, so this is how the event becomes a
 * `POST /store/orders` for a particular Cart — and `null` is what lets a Project ignore the
 * payments in its Stripe account that kobai never started, rather than having to guess.
 *
 * Takes `unknown` deliberately: what arrives at a webhook is a parsed JSON body, and asking a
 * Project to assert a type before it may ask this question would be asking it to trust a
 * shape Stripe promises and this Plugin can check.
 */
export function cartIdOfPaymentIntent(intent: unknown): string | null {
  if (typeof intent !== "object" || intent === null) return null;
  const metadata = (intent as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) return null;

  const cartId = (metadata as Record<string, unknown>)[STRIPE_CART_ID_KEY];
  return typeof cartId === "string" && cartId !== "" ? cartId : null;
}

/** What a Project asks for when a Shopper is about to be sent to their bank. */
export type StartPaymentRequest = {
  /** The Cart being paid for, recorded in the intent's metadata under {@link STRIPE_CART_ID_KEY}. */
  readonly cartId: string;
  /** Minor units of `currency` — what the Cart comes to. */
  readonly amount: number;
  /** ISO 4217. **This is what decides which methods Stripe offers** — see {@link stripePayments}. */
  readonly currency: string;
};

/** What Stripe answered, in the two values a storefront needs and one it can act on. */
export type StartedPayment = {
  /** The PaymentIntent's id — what comes back on `POST /store/orders` once the bank has answered. */
  readonly reference: string;
  /** What Elements is handed in the browser. */
  readonly clientSecret: string;
  /** Stripe's own word for where this intent is, unread by this Plugin and passed on. */
  readonly status: string;
};

/**
 * `@kobai/plugin-stripe`'s provider, and the two operations kobai's interface has no room for.
 *
 * It **is** a `PaymentProvider` — `payments: { provider: stripePayments({ … }) }` is the whole
 * config line — and it carries {@link StripePaymentProvider.startPayment} and
 * {@link StripePaymentProvider.refundUnplacedPayment} beside the three Core knows about.
 * Neither is on `PaymentProvider` and neither should be: Core never starts a payment (the
 * storefront does, through a route the Project owns) and Core never refunds a purchase it
 * refused (it wrote nothing, so there is nothing of Core's to unwind). `PaymentProvider` and
 * `PaymentOutcome` are untouched by this package, which is ADR-0070's decision and not an
 * accident of implementation.
 */
export type StripePaymentProvider = PaymentProvider & {
  readonly startPayment: (request: StartPaymentRequest) => Promise<StartedPayment>;
  /**
   * Give back a payment kobai refused to place, and record it — see
   * {@link refundUnplacedPayment}.
   */
  readonly refundUnplacedPayment: (
    request: UnplacedPaymentRefund,
  ) => Promise<StripeUnplacedRefundRow>;
};

/**
 * Stripe, as a Plugin — one integration covering cards, FPX and GrabPay.
 *
 * **`automatic_payment_methods` is the whole design.** Which methods a Shopper is offered is
 * decided by Stripe from the intent's currency and the Store's dashboard settings, so "FPX
 * only for MYR" needs no kobai code at all and adding GrabPay tomorrow is a checkbox rather
 * than a release. Hosted Checkout was rejected for it: it would put the purchase on pixels
 * kobai does not own (ADR-0002) and would make the API prove less (ADR-0070).
 *
 * ```ts
 * // kobai.config.ts
 * const stripe = stripePayments({ secretKey: process.env.STRIPE_SECRET_KEY ?? "" });
 * export default defineKobaiConfig({
 *   migrationSets: [stripeMigrationSet],
 *   payments: { provider: stripe },
 * });
 * ```
 */
export function stripePayments(options: StripeOptions): StripePaymentProvider {
  return {
    /**
     * Recorded on every Payment this provider takes, so a deployment that changes provider
     * still knows which system holds the money behind an Order placed last year.
     */
    name: "stripe",

    charge: async (request) => {
      const reference = stringOrUndefined(request.metadata[STRIPE_PAYMENT_INTENT_KEY]);
      // An empty string is a storefront that sent the key and filled it with nothing, which
      // is the same fact as not sending it — and asking Stripe about it would be a request
      // for `/v1/payment_intents/`, whose answer says something else entirely.
      if (reference === undefined || reference === "") return missingIntent();

      // Asked for rather than confirmed outright, because for a redirect method the intent
      // has *already* succeeded by the time kobai hears about it — the funds left at the
      // bank — and Stripe answers a confirm on a succeeded intent with a 400.
      const found = await callStripe(options, {
        method: "GET",
        path: `/v1/payment_intents/${encodeURIComponent(reference)}`,
      });
      if (!found.ok) return notFound(found);

      const mismatch = disagreesWith(request, found.body);
      if (mismatch !== undefined) return mismatch;

      // A card entered in Elements without a redirect leaves the intent here, and this is
      // where `charge` really does confirm. Keyed on the intent, so a placement retried after
      // a timeout confirms the same payment rather than taking a second one.
      if (stringOrUndefined(found.body.status) === "requires_confirmation") {
        const confirmed = await callStripe(options, {
          method: "POST",
          path: `/v1/payment_intents/${encodeURIComponent(reference)}/confirm`,
          idempotencyKey: `kobai-confirm-${reference}`,
        });
        if (!confirmed.ok) {
          // Stripe refuses a confirmation for reasons that are the Shopper's — a payment
          // method that cannot be charged — and for reasons that are the deployment's. Both
          // arrive as a 4xx with a sentence, and neither is this Plugin being unreachable.
          return { ok: false, detail: describe(confirmed.error.message) };
        }
        return outcomeOf(reference, confirmed.body);
      }

      return outcomeOf(reference, found.body);
    },

    refund: async ({ reference, amount }) => {
      const result = await callStripe(options, {
        method: "POST",
        path: "/v1/refunds",
        form: { payment_intent: reference, amount },
        // Derived from the payment, so a compensation reached twice for one purchase gets the
        // first refund back rather than making a second one — and so two payments can never
        // collide on a key.
        idempotencyKey: `kobai-refund-${reference}`,
      });

      if (!result.ok) {
        // A throw, because the interface says so and because ADR-0036 needs one: this is
        // reported beside whatever stopped the run, never in place of it, so the Merchant
        // learns money is sitting where it should not be while the Shopper still learns why
        // they were refused.
        throw new Error(
          `Stripe would not refund ${reference}: ${describe(result.error.message)}`,
        );
      }
    },

    refundUnplacedPayment: (request) => refundUnplacedPayment(options, request),

    startPayment: async ({ cartId, amount, currency }) => {
      const result = await callStripe(options, {
        method: "POST",
        path: "/v1/payment_intents",
        form: {
          amount,
          // Stripe's currencies are lower case, kobai's are ISO 4217 as written.
          currency: currency.toLowerCase(),
          automatic_payment_methods: { enabled: true },
          metadata: { [STRIPE_CART_ID_KEY]: cartId },
        },
        // Deliberately no idempotency key. Stripe replays the *first* answer for a repeated
        // key, so a Shopper who edits their Cart and starts again would be sent to their bank
        // for the old total — which is the one failure this whole Plugin exists to avoid.
      });

      if (!result.ok) {
        throw new Error(
          `Stripe refused to create a PaymentIntent for cart ${cartId}: ${describe(result.error.message)}`,
        );
      }

      const reference = stringOrUndefined(result.body.id);
      const clientSecret = stringOrUndefined(result.body.client_secret);
      if (reference === undefined || clientSecret === undefined) {
        throw new Error(
          `Stripe created a PaymentIntent for cart ${cartId} and answered without an id or a client secret.`,
        );
      }

      return {
        reference,
        clientSecret,
        status: stringOrUndefined(result.body.status) ?? "unknown",
      };
    },
  };
}

function describe(message: string | undefined): string {
  return message ?? "it said nothing about why.";
}

/**
 * What a PaymentIntent's status means to kobai, which is a smaller question than it looks.
 *
 * `PaymentOutcome` has two variants and grows no third here (ADR-0070), so every one of
 * Stripe's statuses is one of three things: the money is in, the money is on its way, or this
 * purchase is not happening. The middle one is what {@link PaymentOutcome.received} already
 * says — `processing` is a payment that was arranged and has not landed, which is the same
 * fact the reference Project's `manual` provider reports and is a fact rather than a state
 * kobai will move it through (ADR-0056).
 *
 * `requires_action` and `requires_payment_method` are declines *here* even though a storefront
 * could still rescue them, and that is deliberate: `charge` is only ever called after the
 * redirect completed, so either one means the Shopper did not finish. A `requires_capture` is
 * a decline for a blunter reason — kobai never captures separately, so a Store on manual
 * capture would be told it had been paid for money nobody had taken.
 */
function outcomeOf(reference: string, intent: Record<string, unknown>): PaymentOutcome {
  const status = stringOrUndefined(intent.status);

  if (status === "succeeded") return { ok: true, reference, received: true };
  if (status === "processing") return { ok: true, reference, received: false };

  return { ok: false, detail: declineDetail(intent) };
}

/**
 * For a person, and it reaches the storefront as the `error` of a 402.
 *
 * Stripe writes `last_payment_error.message` for a Shopper — "Your card was declined." — so
 * it is passed through when there is one, and replaced by something equally readable when
 * there is not.
 */
function declineDetail(intent: Record<string, unknown>): string {
  const error = intent.last_payment_error;
  const message =
    typeof error === "object" && error !== null
      ? stringOrUndefined((error as Record<string, unknown>).message)
      : undefined;

  return message ?? "This payment was not completed.";
}

/**
 * Whether this intent is for what Core is about to write the Order for, and a decline if not.
 *
 * The intent is created by a route the **Project** owns and comes back as an opaque string on
 * ADR-0013's open context, so nothing between the browser and here has compared the two
 * figures. Without this, a storefront bug — or a caller who kept a cheap intent from an
 * earlier Cart — buys the expensive Cart for the cheap payment, and Core would record the
 * Order at its own total and be right about a payment that never happened.
 *
 * Currency is compared case-insensitively because Stripe's are lower case and ISO 4217 is
 * written upper.
 */
function disagreesWith(
  request: PaymentRequest,
  intent: Record<string, unknown>,
): PaymentOutcome | undefined {
  const amount = integerOrUndefined(intent.amount);
  const currency = stringOrUndefined(intent.currency);
  const agrees =
    amount === request.amount &&
    currency?.toUpperCase() === request.currency.toUpperCase();

  if (agrees) return undefined;

  return {
    ok: false,
    detail: `This payment is for ${amount ?? "an unknown amount"} ${currency?.toUpperCase() ?? "in an unknown currency"} and this order comes to ${request.amount} ${request.currency}.`,
  };
}

/**
 * A decline rather than a throw, and the detail names what is missing.
 *
 * A throw would be this Plugin reporting that it is broken or unreachable, and it is neither:
 * what happened is that the request carried no PaymentIntent. The Shopper still cannot buy
 * anything, so it is an answer rather than an outage — and the detail says exactly which key
 * was expected, because the person who has to act on this one is the Developer wiring the
 * storefront, not the Shopper reading it.
 */
function missingIntent(): PaymentOutcome {
  return {
    ok: false,
    detail: `This payment could not be found: no ${STRIPE_PAYMENT_INTENT_KEY} was sent with the order.`,
  };
}

/**
 * Stripe would not tell us about this intent — a decline only if it does not exist.
 *
 * **The one place this Plugin has to tell a refusal from an outage**, and it is the interface's
 * own distinction: a decline is an ordinary answer a storefront acts on, and a throw reports
 * that the provider is broken or unreachable. An intent Stripe has never heard of is the first
 * — a storefront sent a reference that is not one, and no Order should be written. A mistyped
 * secret key, a revoked one, a rate limit or a Stripe outage are all the second, and answering
 * any of them as a decline would turn a deployment's own misconfiguration into every Shopper
 * being told their bank said no, with nothing anywhere saying otherwise.
 */
function notFound(failure: Extract<StripeResult, { ok: false }>): PaymentOutcome {
  const missing = failure.status === 404 || failure.error.code === "resource_missing";
  if (!missing) {
    throw new Error(
      `Stripe answered ${failure.status} when this Plugin asked about a PaymentIntent: ${describe(failure.error.message)}`,
    );
  }

  return {
    ok: false,
    detail: `This payment could not be found: ${describe(failure.error.message)}`,
  };
}
