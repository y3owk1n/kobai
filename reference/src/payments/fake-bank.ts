import type { PaymentProvider } from "@kobai/core";
import {
  PAYMENT_REFERENCE_KEY,
  type RedirectPayments,
  type StartedRedirectPayment,
} from "./redirect.ts";

/**
 * **A bank that can be told to abandon, and the more valuable of the two providers ADR-0070
 * produces.**
 *
 * It moves no money and it is not a provider any deployment could use. What it is, is the only
 * way the two interesting paths of a redirect payment can be staged on demand:
 *
 * - **The Shopper never comes back to the tab.** They authorise in their banking app and close
 *   it. Here that is one call made and another simply not made, and the Order still has to
 *   exist. It is the *ordinary* case in Malaysia, and Stripe's own guidance is not to trust the
 *   redirect return.
 * - **The hold lapses while they are away.** The money left at the bank, kobai refuses
 *   `insufficient-inventory` and writes nothing, and the payment has to come back. It is the one
 *   case in the whole design that would otherwise take money and give no goods.
 *
 * **Neither can be staged against a real provider.** Stripe's sandbox will not abandon on
 * command and will not wait fifteen minutes on request, so a gate built on it would test the
 * happy path and describe the other two in prose. That is why this exists, why it lives in the
 * Project rather than in a Plugin, and why `devbox run ci` never calls Stripe.
 *
 * **It keeps books, and asking them is the point.** {@link FakeBank.payment} says what this bank
 * is holding for a reference and what it has given back, because "the refund callback ran" and
 * "the Shopper got their money back" are two different facts and only the second is worth
 * asserting (ADR-0036).
 */

/** One payment at this bank, as its books hold it. */
export type FakeBankPayment = {
  readonly reference: string;
  /** The Cart it was started for — this bank's `metadata`, and how a callback finds the purchase. */
  readonly cartId: string;
  /** Minor units of `currency` — what the Shopper is asked to authorise. */
  readonly amount: number;
  readonly currency: string;
  /** ADR-0013's open context, as the storefront sent it when the payment was started. */
  readonly metadata: Readonly<Record<string, unknown>>;
  /**
   * Where this payment is.
   *
   * `awaiting-the-shopper` is a redirect issued and not yet authorised — the state an abandoned
   * payment stays in for ever if the Shopper closes the tab *before* authorising, which is a
   * different thing from closing it after. `authorised` is money that has left. `refunded` is
   * money that has gone back.
   */
  readonly status: "awaiting-the-shopper" | "authorised" | "refunded";
  /** Minor units given back — zero unless `status` is `refunded`. */
  readonly refunded: number;
  /** kobai's own word for why the money went back, when that is why it did. */
  readonly refusal?: string;
};

/**
 * The fake, and the three things a test drives it with.
 *
 * It is a `PaymentProvider`, so a deployment wires it in `kobai.config.ts` exactly as it wires
 * any other; and it is a {@link RedirectPayments}, so this Project's own route starts payments
 * and gives them back through it. One object doing both is the shape `stripePayments` has, which
 * is what makes swapping this for it a config line rather than a redesign.
 */
export type FakeBank = PaymentProvider &
  RedirectPayments & {
    /** The Shopper authorises, in their banking app. The money leaves here. */
    authorise(reference: string): FakeBankPayment;
    /** What this bank is holding, and what it has given back. `undefined` for a reference it never issued. */
    payment(reference: string): FakeBankPayment | undefined;
    /** The callback body this bank posts when a payment is authorised. */
    callbackFor(reference: string): unknown;
  };

/** The key a payment's Cart travels under in this bank's metadata — the mirror of Stripe's. */
const CART_ID_KEY = "kobaiCartId";

export function createFakeBank(): FakeBank {
  const payments = new Map<string, FakeBankPayment>();

  const put = (payment: FakeBankPayment): FakeBankPayment => {
    payments.set(payment.reference, payment);
    return payment;
  };

  return {
    /**
     * Recorded on every Payment it takes, and unmistakable on purpose — the same choice
     * `everything-costs-one-cent` makes. Nobody reading an Order in the Admin should have to
     * work out whether this was real money.
     */
    name: "fake-bank",

    /**
     * The key this bank reads its own reference back under — this Project's own, because this
     * bank is this Project's own source. A provider from a Plugin names the key that Plugin
     * reads: `@kobai/plugin-stripe`'s is `stripePaymentIntent`.
     */
    referenceKey: PAYMENT_REFERENCE_KEY,

    /**
     * **Confirms that the money left, and never takes it.** That is what a redirect method is:
     * by the time kobai asks, the Shopper has authorised at their bank and the funds are gone,
     * so this reports what happened rather than making it happen — which is exactly why
     * `PaymentOutcome` needs no third variant (ADR-0070).
     *
     * Three declines, and each is a real failure a storefront can meet: a request with no
     * reference on it, a reference this bank never issued, and a payment the Shopper never
     * authorised. The last is the one worth having — it is what makes "the Order exists" a fact
     * about the *bank* having answered rather than about a URL having been visited.
     */
    charge: async ({ amount, currency, metadata }) => {
      const reference = metadata[PAYMENT_REFERENCE_KEY];
      if (typeof reference !== "string" || reference === "") {
        return {
          ok: false,
          detail: `This payment could not be found: no ${PAYMENT_REFERENCE_KEY} was sent with the order.`,
        };
      }

      const payment = payments.get(reference);
      if (!payment) {
        return { ok: false, detail: "This bank has never heard of that payment." };
      }
      if (payment.status !== "authorised") {
        return {
          ok: false,
          detail: "The Shopper has not authorised this payment at their bank.",
        };
      }

      // **What the Shopper authorised is what kobai is about to charge, or this is not taken**
      // (ADR-0077). The Cart is mutable by design, so a line added while the Shopper was away is
      // an ordinary thing that happens — and an expensive Cart bought with a cheap payment is
      // money that never arrived. `POST /store/carts/{id}/quote` is the figure to start a
      // payment for, and the route in this directory starts it for exactly that.
      if (payment.amount !== amount || payment.currency !== currency) {
        return {
          ok: false,
          detail: `This payment is for ${payment.amount} ${payment.currency} and this Order comes to ${amount} ${currency}, so it was not taken.`,
        };
      }

      return { ok: true, reference, received: true };
    },

    /**
     * `take-payment`'s compensation — a later Step failed after the money moved.
     *
     * Distinct from {@link RedirectPayments.refundUnplacedPayment} in what it is reached by
     * rather than in what it does: this one unwinds a purchase kobai had already charged for,
     * and that one gives back money kobai never charged and never wrote an Order for.
     */
    refund: async ({ reference, amount }) => {
      const payment = payments.get(reference);
      if (!payment) {
        throw new Error(`This bank cannot refund ${reference}: it never took it.`);
      }
      put({ ...payment, status: "refunded", refunded: amount });
    },

    startPayment: async ({
      cartId,
      metadata,
      amount,
      currency,
    }): Promise<StartedRedirectPayment> => {
      const reference = `fake-bank-${crypto.randomUUID()}`;
      put({
        reference,
        cartId,
        metadata,
        amount,
        currency,
        status: "awaiting-the-shopper",
        refunded: 0,
      });

      return {
        reference,
        // A URL nobody dials. What a Shopper does at their bank is the one part of this flow
        // that is genuinely somebody else's, and a fake that pretended otherwise would be
        // testing its own web page.
        redirectUrl: `https://bank.invalid/authorise/${reference}`,
      };
    },

    /**
     * What this bank was asked to take, read back by its reference — the Cart, and the context
     * the payment was started with.
     *
     * **Both callers settle from here rather than from what they were sent**, which is what
     * makes their two requests one. It is also the binding that keeps a reference from being
     * pointed at a Cart it was not taken for: the Shopper's browser sends this bank's own
     * handle and nothing else, and everything the placement then names comes from this row.
     */
    paymentOf: async (reference) => {
      const payment = payments.get(reference);
      return payment ? { cartId: payment.cartId, metadata: payment.metadata } : null;
    },

    referenceOfCallback: (body) => {
      if (typeof body !== "object" || body === null) return null;
      const payment = (body as { payment?: unknown }).payment;
      if (typeof payment !== "object" || payment === null) return null;

      const { reference } = payment as { reference?: unknown };
      return typeof reference === "string" && reference !== "" ? reference : null;
    },

    /**
     * Gives the whole payment back, because kobai would not place it.
     *
     * Idempotent, because both callers of `POST /store/orders` can meet the same refusal and so
     * can both arrive here: the second ask finds the money already returned and claims nothing
     * twice, which is what keeps a Merchant's books and a bank's agreeing.
     *
     * **A payment the Shopper never authorised is left alone, and that is not a special case
     * to tidy away.** The route asks for a refund on every refusal, because the route cannot
     * know whether any money moved — only the system holding it can. Writing a refund for one
     * that never moved would put a figure in a Merchant's books that no bank statement will
     * ever match, which is the same failure as not refunding, in the other direction.
     */
    refundUnplacedPayment: async ({ reference, cartId, refusal }) => {
      const payment = payments.get(reference);
      if (!payment) {
        throw new Error(`This bank cannot refund ${reference}: it never took it.`);
      }
      if (payment.cartId !== cartId) {
        throw new Error(
          `This bank took ${reference} for cart ${payment.cartId}, and was asked to give it back for ${cartId}.`,
        );
      }
      if (payment.status !== "authorised") return;

      put({ ...payment, status: "refunded", refunded: payment.amount, refusal });
    },

    authorise: (reference) => {
      const payment = payments.get(reference);
      if (!payment) {
        throw new Error(`This bank has no payment ${reference} to authorise.`);
      }
      return put({ ...payment, status: "authorised" });
    },

    payment: (reference) => payments.get(reference),

    callbackFor: (reference) => {
      const payment = payments.get(reference);
      if (!payment) {
        throw new Error(`This bank has no payment ${reference} to report.`);
      }
      // Shaped like a real one: an event wrapping the payment, with the Cart in the payment's
      // own metadata the way Stripe puts it on an intent. Only the reference is read back out
      // of it — see `paymentOf` — but a callback that carried less than a real provider's would
      // be a fake making the Project's job easier than it is.
      return {
        type: "payment.authorised",
        payment: {
          reference: payment.reference,
          status: payment.status,
          amount: payment.amount,
          currency: payment.currency,
          metadata: { [CART_ID_KEY]: payment.cartId },
        },
      };
    },
  };
}
