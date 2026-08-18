import type { OrderShopper } from "../order/read.ts";

/**
 * **`PaymentProvider`** — the interface Core defines and implements nowhere (ADR-0053).
 *
 * Core owns the Payment *record*, because without it an Order holds no account of the money and
 * a Return has nothing to refund against. It ships no provider at all, and that asymmetry is the
 * decision rather than an omission: dependency substitution (ADR-0003's third Extension Point)
 * had exactly one named interface whose every implementation was Core's own, so a second one
 * supplied by Core too would have reproduced #72's finding instead of closing it. The one
 * provider that exists is the reference Project's `manual`, in the Project's own source.
 *
 * A deployment that wires none still boots, still serves its catalog and still serves the Admin.
 * It refuses `place-order` alone, with `no-payment-provider` — a store that cannot yet be bought
 * from is still a store worth reading, and refusing to boot is reserved for a database that
 * cannot be migrated (ADR-0048).
 *
 * ```ts
 * // kobai.config.ts
 * export default defineKobaiConfig({ payments: { provider: myProvider } });
 * ```
 *
 * ## The shape, and why it is this one
 *
 * ADR-0019 puts an interface's shape under semver **forever** once shipped, so #72 asked for a
 * deliberate look at `Logger`'s before anything copied it. This is that look, and what it kept
 * and what it changed are both recorded here.
 *
 * **Kept from `Logger`.** A plain object type of a couple of operations, wired through
 * `kobai.config.ts` and substituted whole. No class to extend, no base to inherit, no `init` or
 * `close` — Core never constructs a provider and never disposes of one, so a lifecycle would be
 * a contract about a thing Core does not manage. Anything that does the operations is
 * acceptable, which is what makes an adapter around somebody's SDK a five-line object.
 *
 * **Changed from `Logger` as it stood, and since kept by it.** Each operation is a **property
 * holding a function** rather than a method, exactly as `Step.run` is and for the identical
 * reason: TypeScript checks method parameters bivariantly and function-property parameters
 * contravariantly, so only this spelling makes a provider that demands *more* than Core sends a
 * compile error rather than a runtime surprise. This was the first interface to say so, and #127
 * then moved `Logger`, `ReservationProvider` and `Codemod` to it — so **every interface kobai
 * asks somebody else to implement now agrees**, and the next one is copied from a set rather than
 * from whichever file was opened first. The mistake it catches is a plausible one here —
 * `charge: (request: PaymentRequest & { token: string }) => …`, from an SDK that wants a payment
 * method Core does not model — and the honest answer to it is that such a token arrives through
 * {@link PaymentRequest.metadata}, which is ADR-0013's open context and needs no change to Core.
 *
 * **`charge` is a verb here and never a noun.** `CONTEXT.md` bans *charge* as a word for the
 * Payment record, and that ban is kept: the record is a Payment, the thing Core sends is a
 * {@link PaymentRequest}, and `charge` names only the act of asking for the money — which is what
 * every payment provider's own documentation calls it, and so what an adapter author reaches for first.
 *
 * **What a provider is never asked for.** It is not given the Cart's identifier: holding one is
 * the whole of the authority to act on that Cart (ADR-0020), and a credential a third party has
 * no use for should not leave the deployment. It is not given an Order either, because at the
 * moment it is asked there is not one yet — the Order is written after the money moves, which is
 * what makes `capture-order` the point of no return.
 *
 * ## The two flows this covers, and the one it does not
 *
 * **A card charged directly.** The storefront tokenises the card — its own field, the provider's
 * SDK, however it likes — and sends that token on the request that places the Order. It arrives in
 * {@link PaymentRequest.metadata} verbatim, the adapter reads its own key out of it and asks its
 * own service, and the answer is `ok` or a decline. Core is not in the way and learns nothing
 * about cards.
 *
 * **A payment the Shopper completes somewhere else** — FPX, iDEAL, PayPal, a 3-D Secure
 * challenge. The redirect happens **before** the Order is placed: the storefront asks the
 * provider for an authorisation, sends the Shopper to their bank, and calls `POST /store/orders`
 * when they come back, carrying whatever it was given to identify the completed authorisation.
 * That reference travels through `metadata` exactly as a card token does, and `charge` means
 * *confirm this and take it* rather than *start something*. The Cart is untouched while the
 * Shopper is away, and it is still exactly one request that turns it into an Order.
 *
 * **The open context is a query string on this route**, which is ADR-0013's mechanism and not
 * this interface's to change — so a value sent that way is in a URL, with everything that implies
 * about access logs and `Referer` headers. It is the right door for a one-time reference a
 * provider issued and can only be spent once; a Project that needs to send something it would
 * rather not put in a URL puts it on the **Cart** instead, where a `PATCH` body carries it and a
 * replaced `take-payment` Step reads it off `input.cart.metadata`. That a stock provider has only
 * the query string is a finding about the route rather than something to work around here.
 *
 * **What kobai does not do is send the Shopper anywhere itself.** An Order that existed while a
 * Shopper was still at their bank would be an Order waiting on an answer nobody has, and settling
 * it later needs a route to resume on and a webhook to hear the bank on, which is events (#70)
 * and is out of scope by decision. So the rule this interface keeps is the simple one: **a placed
 * Order is one whose payment has been asked for and answered**, and a payment that has not
 * happened yet is a request that has not been made yet.
 *
 * The answer is not always *the money moved*, and {@link PaymentOutcome.received} is where the
 * difference is kept. A provider that arranges payment out of band has answered — the
 * arrangement is made, the Order is real — and the money has not arrived, which is a fact about
 * this purchase and not a state it will be moved through. Nothing updates it: an Order is
 * immutable (ADR-0009), so an unreceived Payment stays one and collecting is a Merchant's job,
 * out of band, exactly where it was before kobai wrote the fact down.
 *
 * That is a decision this shape can revisit without breaking anybody, which is why it is safe to
 * take now. {@link PaymentOutcome} is *produced* by a provider and read by Core, so Core may grow
 * the union a third variant — "send the Shopper here, then place the Order again" — and every
 * provider written against today's shape still compiles and still never produces it.
 * {@link PaymentRequest} runs the other way, produced by Core and read by a provider, so it may
 * grow a field for the same reason. The direction of each type is what makes the extension
 * additive, and it is the property to preserve if either is ever changed (ADR-0019).
 */
export type PaymentProvider = {
  /**
   * What this provider is called, recorded on every Payment it takes.
   *
   * Written down rather than inferred, because a deployment that changes provider still has to
   * know which one holds the money behind an Order placed last year — a `reference` is
   * meaningless without the system that issued it. Short and machine-readable: `manual`,
   * `stripe`.
   */
  readonly name: string;
  /**
   * Takes the money, or declines — or says it has arranged for it rather than taken it.
   *
   * **Declining is a value, not a throw.** A card refused is an ordinary answer that a storefront
   * acts on — Core turns it into `payment-declined` at 402 and no Order is written — while a
   * provider that *throws* is reporting that it is broken or unreachable, which travels as the
   * 500 it is. A provider that threw for a decline would report an outage every time a Shopper
   * mistyped a card number.
   */
  readonly charge: (request: PaymentRequest) => Promise<PaymentOutcome>;
  /**
   * Gives it back — called by `take-payment`'s compensation when a later Step fails.
   *
   * Answers nothing, because by the time it runs the purchase is already lost and there is no
   * decision left for its result to inform. It throws if it could not refund, and that throw is
   * contained the way every compensation's is (ADR-0036): it is reported beside whatever stopped
   * the run — never in place of it — as `uncompensated`, so a Merchant learns that money is
   * sitting somewhere it should not be while the Shopper still learns why they were refused.
   *
   * What a *partial* refund means is deliberately not decided here. Returns are their own spec,
   * and this is the whole refund of a payment that should never have been taken.
   */
  readonly refund: (payment: RefundRequest) => Promise<void>;
};

/** What a provider is asked to take, at the moment `place-order` knows what the Order comes to. */
export type PaymentRequest = {
  /**
   * Minor units of `currency` — 1250 is USD 12.50, and it is exactly what the Order will be
   * written for. Core composes it from the lines, their Adjustments and their tax rather than
   * asking a Step for a total, so the figure charged and the figure recorded cannot drift.
   */
  readonly amount: number;
  /** ISO 4217, and the one currency this Order is in. */
  readonly currency: string;
  /**
   * Who the storefront said the Shopper is, or `null` for a guest — which is the ordinary case,
   * because Core assumes an authenticated Shopper nowhere (ADR-0020).
   */
  readonly shopper: OrderShopper | null;
  /**
   * Everything the caller sent that Core does not model, verbatim (ADR-0013).
   *
   * This is where a payment method token, a saved-card handle or anything else a real provider
   * needs comes through, so wiring a provider that wants one is a Project's business and not a
   * change to Core. Core reads no key out of it and never will.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
};

/** Money moved, or it did not. */
export type PaymentOutcome =
  | {
      readonly ok: true;
      /**
       * The provider's own handle on this payment — a Stripe `PaymentIntent` id, an invoice
       * number, whatever the system that holds the money calls it.
       *
       * Core stores it and never parses it. It is what a refund is asked against, and what a
       * Merchant quotes to reconcile an Order against the provider's own books.
       */
      readonly reference: string;
      /**
       * Whether the money **has actually arrived**, or was only arranged for.
       *
       * Defaults to `true`, which is what `ok: true` has meant since this interface shipped —
       * *takes the money*. A provider written before this field existed keeps meaning exactly
       * that and needs no edit, and a card processor that charged a card has nothing to say
       * here.
       *
       * `false` is for a provider that arranges the money instead of taking it: an invoice, a
       * bank transfer, cash at the counter. The reference Project's `manual` provider is
       * precisely that one — it moves nothing and records that somebody will be asked — and
       * without this the Order it produces is indistinguishable from a completed sale in the
       * Admin, which is the mistake it exists to prevent.
       *
       * **It is a record of what happened, not a state to be moved through.** Core writes it at
       * Capture and never updates it: an Order is immutable (ADR-0009), and a payment lifecycle
       * — settling later, hearing a bank on a webhook, resuming a redirect — needs events (#70)
       * and belongs to the specs that own it. What a Merchant does with an unreceived Payment is
       * collect it, out of band, exactly as they did before kobai recorded the fact.
       */
      readonly received?: boolean;
    }
  | {
      readonly ok: false;
      /**
       * For a person, and it reaches the storefront as the `error` of a 402.
       *
       * So it says what a Shopper can do about it — "the card was declined" — rather than
       * anything the provider would not want a stranger reading.
       */
      readonly detail: string;
    };

/** What a compensation asks to be given back: the payment that was taken, whole. */
export type RefundRequest = {
  /** The `reference` this provider answered with when it took the money. */
  readonly reference: string;
  /** What was taken, in minor units of `currency` — the whole of it. */
  readonly amount: number;
  readonly currency: string;
};

/**
 * What a Project says about payments in `kobai.config.ts` — a subject, not a scalar (ADR-0050).
 *
 * Nested so that the next thing a deployment needs to say about its payments goes beside the
 * provider rather than forcing this shape after the fact, which is the same reason `session` is
 * a key holding `idleWindowMs` instead of a top-level number.
 */
export type PaymentsOptions = {
  /**
   * The provider this deployment takes money through. Absent is a working deployment that cannot
   * be bought from yet — see {@link PaymentProvider}.
   */
  readonly provider?: PaymentProvider;
};
