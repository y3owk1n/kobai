import type { PaymentOutcome, PaymentProvider, PaymentRequest } from "@kobai/core";
import {
  callStripe,
  integerOrUndefined,
  type StripeOptions,
  type StripeResult,
  stringOrUndefined,
  stripeSaid,
} from "./api.ts";
import type { StripeUnplacedRefundRow } from "./db/schema.ts";
import {
  cartIdOfPaymentIntent,
  contextOfPaymentIntent,
  STRIPE_CART_ID_KEY,
  STRIPE_CONTEXT_KEY,
  STRIPE_PAYMENT_INTENT_KEY,
  stripeContextValue,
} from "./metadata.ts";
import {
  refundUnplacedPayment,
  type UnplacedPaymentRefund,
} from "./refund-unplaced-payment.ts";

/** What a Project asks for when a Shopper is about to be sent to their bank. */
export type StartPaymentRequest = {
  /** The Cart being paid for, recorded in the intent's metadata under {@link STRIPE_CART_ID_KEY}. */
  readonly cartId: string;
  /** Minor units of `currency` — what the Cart comes to. */
  readonly amount: number;
  /** ISO 4217. **This is what decides which methods Stripe offers** — see {@link stripePayments}. */
  readonly currency: string;
  /**
   * ADR-0013's open context, as the storefront sent it when the Cart was quoted.
   *
   * Recorded on the intent under {@link STRIPE_CONTEXT_KEY} so that the placement runs with
   * the context the quote ran with — see that key for how a bag of anything travels through
   * metadata Stripe holds as strings, and for the one payment this Plugin refuses to start.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/** What a payment was started for, read back off the intent by {@link StripePaymentProvider.paymentOf}. */
export type StartedPaymentDetails = {
  /** The Cart it was started for. */
  readonly cartId: string;
  /** The open context it was started with — `{}` for a purchase that carried none. */
  readonly metadata: Readonly<Record<string, unknown>>;
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
   * What a payment was started for, by its reference — `null` for one this Plugin never
   * started.
   *
   * **This is what the settling half of the flow reads everything from.** The Shopper's
   * returning browser holds a reference and nothing else, and the webhook holds only what
   * Stripe sends, so a Project that took the Cart from the request would be letting the two
   * callers make different requests under the one `Idempotency-Key` they share (ADR-0070).
   * One source, one body, either caller.
   *
   * `null` is an answer rather than a failure: a Store's Stripe account holds payments kobai
   * never started, and a Project may turn one back without guessing at a Cart for it. Stripe
   * being unreachable or refusing the key is the other thing entirely, and throws.
   */
  readonly paymentOf: (reference: string) => Promise<StartedPaymentDetails | null>;
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

      // **The money in the intent is what kobai is about to charge, or this payment is not
      // taken** (ADR-0077). This used to be a documented gap: a Cart carried no total, so a
      // storefront had no kobai-supplied figure to create the intent for, and a comparison here
      // would have declined every purchase in a Store with tax or an Adjustment. `POST
      // /store/carts/{id}/quote` is that figure now, so the mismatch is back to being the
      // exceptional case it always should have been — and it is the exceptional case that
      // matters, because Core records the Order at *its* total and the books would otherwise
      // balance against money that never arrived.
      //
      // In front of the confirm below rather than after it, and what that buys depends on which
      // of the two flows this is. **A card at `requires_confirmation` has not been charged**, so
      // refusing here leaves the Shopper unbilled instead of billed and refunded. **A redirect
      // intent that already succeeded has taken the money at the bank** — nothing in this
      // Plugin can undo that by refusing — so there the decline is Core's `payment-declined`,
      // no Order is written, and giving the money back is the Project's call to
      // `refundUnplacedPayment`: exactly the path ADR-0070 already describes for a hold that
      // lapsed while the Shopper was away, reached by a second cause.
      const mismatch = declineIfItDisagreesWith(request, found.body);
      if (mismatch) return mismatch;

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
          return { ok: false, detail: stripeSaid(confirmed.error.message) };
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
          `Stripe would not refund ${reference}: ${stripeSaid(result.error.message)}`,
        );
      }
    },

    refundUnplacedPayment: (request) => refundUnplacedPayment(options, request),

    paymentOf: async (reference) => {
      const found = await callStripe(options, {
        method: "GET",
        path: `/v1/payment_intents/${encodeURIComponent(reference)}`,
      });
      if (!found.ok) {
        // The same reading `charge` makes, through the same function: an intent Stripe has
        // never heard of is a payment this Plugin did not start, and anything else — a
        // mistyped key, a revoked one, a rate limit, an outage — is the deployment being
        // broken and must not read as a stranger's payment.
        if (stripeNeverHeardOfIt(found)) return null;
        throw new Error(
          `Stripe answered ${found.status} when this Plugin asked about a PaymentIntent: ${stripeSaid(found.error.message)}`,
        );
      }

      const cartId = cartIdOfPaymentIntent(found.body);
      // A payment in this Store's Stripe account with no Cart on it is one kobai never
      // started, and there is nothing to settle for it.
      if (cartId === null) return null;

      return { cartId, metadata: contextOfPaymentIntent(found.body) };
    },

    startPayment: async ({ cartId, amount, currency, metadata }) => {
      // Before the intent exists, because a context Stripe would not carry back is a payment
      // that must not be started at all — see STRIPE_CONTEXT_KEY.
      const context = stripeContextValue(metadata);

      const result = await callStripe(options, {
        method: "POST",
        path: "/v1/payment_intents",
        form: {
          amount,
          // Stripe's currencies are lower case, kobai's are ISO 4217 as written.
          currency: currency.toLowerCase(),
          automatic_payment_methods: { enabled: true },
          metadata: { [STRIPE_CART_ID_KEY]: cartId, [STRIPE_CONTEXT_KEY]: context },
        },
        // Deliberately no idempotency key. Stripe replays the *first* answer for a repeated
        // key, so a Shopper who edits their Cart and starts again would be sent to their bank
        // for the old total — which is the one failure this whole Plugin exists to avoid.
      });

      if (!result.ok) {
        throw new Error(
          `Stripe refused to create a PaymentIntent for cart ${cartId}: ${stripeSaid(result.error.message)}`,
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
 * Whether this PaymentIntent is for what Core is about to charge — the decline if it is not.
 *
 * **This is the half of ADR-0077 that closes the loop.** The route that quotes a Cart gives a
 * storefront the figure to start a payment for; nothing binds the two, and nothing could — the
 * Cart is mutable by design (ADR-0009), so a line added between the redirect and the return is
 * an ordinary thing that happens. What this does is refuse the purchase when the two figures
 * have come apart, so that an expensive Cart cannot be bought with a cheap payment.
 *
 * **Both halves are compared, and the currency is not the cosmetic one.** 2500 of one currency
 * is not 2500 of another, so a check on the number alone would take a payment in the wrong money
 * and let Core record the Order in kobai's. Stripe writes its currencies in lower case and kobai
 * writes ISO 4217 as it is written, which is the one difference this has to know about.
 *
 * **An intent with no amount is a decline too**, and deliberately not a throw: an amount is not
 * something Stripe omits, so what is on the other end of that answer is something this Plugin
 * cannot check a payment against — and confirming against it would be trusting exactly the thing
 * that could not be verified. A throw would say the deployment is broken, which is the other
 * diagnosis and is {@link notFound}'s to make.
 *
 * The detail is written for the Developer wiring the storefront rather than for the Shopper —
 * the same choice {@link missingIntent} makes, and for the same reason: a Shopper can do nothing
 * about this, and the person who can needs to be told which two figures disagreed.
 */
function declineIfItDisagreesWith(
  request: PaymentRequest,
  intent: Record<string, unknown>,
): PaymentOutcome | undefined {
  const amount = integerOrUndefined(intent.amount);
  const currency = stringOrUndefined(intent.currency);
  if (amount === undefined || currency === undefined) {
    return {
      ok: false,
      detail:
        "This payment was described without an amount or a currency, so it could not be checked against what this Order comes to, and it was not taken.",
    };
  }
  if (amount === request.amount && currency === request.currency.toLowerCase()) {
    return undefined;
  }

  return {
    ok: false,
    detail: `This payment is for ${amount} ${currency.toUpperCase()} and this Order comes to ${request.amount} ${request.currency}, so it was not taken. Ask \`POST /store/carts/{id}/quote\` for what the Cart comes to and start the payment for that.`,
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
  if (!stripeNeverHeardOfIt(failure)) {
    throw new Error(
      `Stripe answered ${failure.status} when this Plugin asked about a PaymentIntent: ${stripeSaid(failure.error.message)}`,
    );
  }

  return {
    ok: false,
    detail: `This payment could not be found: ${stripeSaid(failure.error.message)}`,
  };
}

/**
 * Whether Stripe's refusal means *there is no such payment* rather than *this Plugin could not
 * ask*.
 *
 * One reading in one place, because both callers of `/v1/payment_intents/{id}` turn on it and
 * two copies would eventually disagree about which of them a 401 is.
 */
function stripeNeverHeardOfIt(failure: Extract<StripeResult, { ok: false }>): boolean {
  return failure.status === 404 || failure.error.code === "resource_missing";
}
