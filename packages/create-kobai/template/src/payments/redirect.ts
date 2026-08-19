import type { ProjectFetch } from "../app.ts";

/**
 * **A payment the Shopper completes at their bank, settled by this Project** (ADR-0070).
 *
 * FPX, iDEAL, PayPal, a 3-D Secure challenge: the money leaves when the Shopper authorises
 * *there*, not when kobai says yes. So the purchase is three calls rather than one, and two of
 * them are this Project's:
 *
 * 1. The storefront holds the Cart's stock (`POST /store/carts/{id}/reservations`) and asks what
 *    it comes to (`POST /store/carts/{id}/quote`) — both kobai's, both on the storefront's key.
 * 2. It calls {@link REDIRECT_START_PATH} here, which starts a payment for the quoted figure and
 *    answers where to send the Shopper.
 * 3. The bank answers, twice over and in either order: the Shopper's browser comes back to
 *    {@link REDIRECT_RETURN_PATH}, and the provider posts to {@link REDIRECT_CALLBACK_PATH}.
 *    **Both are the same kobai call** — `POST /store/orders`, carrying the provider's reference
 *    and an `Idempotency-Key` derived from it — so neither has to know about the other and
 *    either may be the one that wins. #102 makes exactly one Order out of the two.
 *
 * **This is the Project's route and not Core's and not a Plugin's**, and here that is a feature
 * rather than a limitation. A Plugin cannot add a route — routes are not one of ADR-0003's five
 * Extension Points — and signature verification, logging and whatever a bank does that nobody
 * anticipated are exactly the things a deployment wants to own. This Project already forks its
 * own paths for the Admin, so this is one more question asked in `app.ts`.
 *
 * **No Order exists until the bank has answered.** Nothing here writes a pending anything: the
 * Cart is what is allowed to be in flight, because it is mutable, disposable and unauthoritative
 * by design (ADR-0009), and it is still a Cart while the Shopper is in their banking app.
 */

/**
 * The key this Project's **own** providers read their reference back under, in the **body**
 * half of ADR-0013's open context — `src/payments/fake-bank.ts` is the one that does.
 *
 * Never the query string, and that is a decision rather than a style (#138). A reference is what
 * `charge` confirms a payment with, so it is a credential — and a query string is written to
 * access logs, to proxy logs, and to the `Referer` of every image a confirmation page loads. The
 * body half exists for exactly this, and `POST /store/orders` refuses a key that arrives in both.
 *
 * **Which key it is, though, is the provider's to say** — see {@link RedirectPayments.referenceKey}.
 * The open context reaches a Payment Provider verbatim (ADR-0013), so a Plugin that ships a
 * provider ships the key it reads: `@kobai/plugin-stripe` reads `stripePaymentIntent`. A Project
 * that made this constant the answer for everybody would be settling every payment with a key
 * half its providers have never heard of, which reads as `payment-declined` on a purchase whose
 * money has already left the Shopper's bank.
 */
export const PAYMENT_REFERENCE_KEY = "redirectPaymentReference";

/** Where this Project serves the redirect flow. Nothing under it is kobai's surface. */
export const REDIRECT_PATH = "/payments/redirect";

/** The storefront's call, before the Shopper leaves: start a payment for this Cart. */
export const REDIRECT_START_PATH = REDIRECT_PATH;

/** Where the Shopper's browser comes back to, if it comes back at all. */
export const REDIRECT_RETURN_PATH = `${REDIRECT_PATH}/return`;

/** Where the provider says the bank answered — the call that arrives whether or not the Shopper does. */
export const REDIRECT_CALLBACK_PATH = `${REDIRECT_PATH}/callback`;

/** What a payment provider answers when a Shopper is about to be sent to their bank. */
export type StartedRedirectPayment = {
  /** The provider's own handle on this payment — what `charge` will be given to confirm. */
  readonly reference: string;
  /**
   * Where to send the Shopper.
   *
   * A bank's own page for FPX; for a provider whose redirect is driven in the browser — Stripe
   * Elements, say — a page of the storefront's that mounts it, with whatever that needs.
   */
  readonly redirectUrl: string;
};

/**
 * What settling a payment needs, and **the provider is the only thing that has it**.
 *
 * Both halves of the bank's answer read it back from there rather than carrying it: the
 * returning browser could send the Cart, and the callback could not, and the two would then be
 * making different requests under one `Idempotency-Key` — which #102 refuses as a reuse rather
 * than answering with the Order. One source, one body, either caller.
 */
export type SettlingPayment = {
  /** The Cart this payment was started for. */
  readonly cartId: string;
  /**
   * The open context it was **quoted** with, so the context it must be **placed** with.
   *
   * ADR-0013's context is whatever the storefront sent that Core does not model — a lead time,
   * a customer tier — and a deployment's Steps may price on it. A quote run with it and a
   * placement run without it are two different figures for one purchase, which is the exact
   * disagreement ADR-0077 exists to remove; so it is recorded when the payment is started and
   * sent again when the Order is placed.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
};

/**
 * What this Project asks of a redirect payment provider, and the whole of it.
 *
 * Four calls, none of them on Core's `PaymentProvider` and none of them wanting to be: Core
 * never starts a payment (the storefront does, through this route) and Core never gives back a
 * purchase it refused (it wrote nothing, so there is nothing of Core's to unwind). ADR-0070
 * decides both, and `PaymentOutcome` grows no third variant on the strength of them.
 *
 * It is the **Project's** interface rather than kobai's. `@kobai/plugin-stripe`'s
 * `stripePayments({ … })` answers `startPayment` in this shape already, reads a Cart off an
 * intent with `cartIdOfPaymentIntent`, and wants the Project's `kobai.db` for the refund — which
 * is a closure where this Project mounts the routes rather than an argument it carries around.
 */
export type RedirectPayments = {
  /**
   * The key this provider reads its own reference back under, on `POST /store/orders`.
   *
   * **A provider names it, because a provider is what reads it.** kobai passes the open
   * context to a Payment Provider verbatim and interprets none of it (ADR-0013), so the key is
   * a matter between the thing that starts a payment and the thing that confirms it — and for
   * a provider from a Plugin, that Plugin has already chosen: `@kobai/plugin-stripe` reads
   * `stripePaymentIntent`. Sending anything else would place the Order without a reference on
   * it, which arrives as `payment-declined` for a payment that has *already* taken the
   * Shopper's money at their bank.
   */
  readonly referenceKey: string;
  /**
   * Start a payment for what the Cart comes to, and say where to send the Shopper.
   *
   * The amount is kobai's own — `POST /store/carts/{id}/quote`'s — rather than a storefront's
   * arithmetic over prices it read, which is the whole of ADR-0077: a payment started for a
   * figure nothing stands behind buys an expensive Cart with a cheap one.
   */
  readonly startPayment: (
    request: SettlingPayment & {
      readonly amount: number;
      readonly currency: string;
    },
  ) => Promise<StartedRedirectPayment>;
  /** What this payment was started for, or `null` for a reference this provider never issued. */
  readonly paymentOf: (reference: string) => Promise<SettlingPayment | null>;
  /**
   * Which payment a callback is about — or `null` for one this Project did not start.
   *
   * Takes `unknown` deliberately: what arrives at a callback is a parsed JSON body, and asking a
   * caller to assert a shape before it may ask this question would be asking it to trust exactly
   * the thing the provider is here to check.
   */
  readonly referenceOfCallback: (body: unknown) => string | null;
  /**
   * Give the whole payment back, because kobai would not place it.
   *
   * The case in view is a hold that lapsed while the Shopper was in their banking app: the money
   * left at the bank, kobai refused `insufficient-inventory` and wrote nothing, and this is the
   * one path in the whole design that would otherwise take money and give no goods.
   */
  readonly refundUnplacedPayment: (request: {
    readonly reference: string;
    readonly cartId: string;
    /** kobai's own word for why, recorded verbatim. */
    readonly refusal: string;
  }) => Promise<void>;
};

/**
 * The `Idempotency-Key` both callers send, **derived from the reference and from nothing else**.
 *
 * That is what makes the Shopper's return and the provider's callback one intention rather than
 * two: they arrive at different moments, from different networks, knowing nothing of each other,
 * and they claim the same key. #102 does the rest — one runs, the other is answered with the
 * Order it produced, and a Cart becomes exactly one Order either way.
 *
 * Prefixed, so that a reference which happens to look like some other caller's key cannot
 * collide with it.
 */
export function idempotencyKeyFor(reference: string): string {
  return `redirect-payment-${reference}`;
}

/** What this Project needs before it can settle anything. */
export type RedirectPaymentOptions = {
  /** kobai, in this process. Every call below goes through its public store surface. */
  readonly kobai: { readonly fetch: ProjectFetch };
  readonly payments: RedirectPayments;
  /**
   * A **secret** store API key, because holding stock and placing Orders are behind one
   * (ADR-0055).
   *
   * This is a server-to-server credential and this route is a server: the browser's publishable
   * key never comes near it. An empty one is a deployment that has not been given a key, and
   * every call below refuses rather than dispatching a request that would be answered 401.
   */
  readonly apiKey: string;
};

/** Mounted the way the Admin is: one question about the path, then this Project's own answer. */
export type RedirectPaymentRoutes = {
  claims(pathname: string): boolean;
  fetch(request: Request): Promise<Response>;
  /**
   * **Settle a payment by its reference — the one call, reached from anywhere.**
   *
   * The Shopper's return and this provider's callback both end here, and so does a route a
   * deployment mounts for a provider that signs its own webhooks — `/webhooks/stripe` is that
   * route in this Project (ADR-0070). What differs between them is how the *reference* is
   * read out of a request, which is the only thing they may decide for themselves: everything
   * the placement then names is read back from the provider, and the `Idempotency-Key` is
   * derived from the reference, so however many of them arrive there is exactly one Order.
   *
   * The `Request` is only ever a base for the URLs kobai is called on; nothing is read out of
   * it, because a caller that could add to the placement would be a second body under one key.
   */
  settle(reference: string, request: Request): Promise<Response>;
};

export function createRedirectPaymentRoutes(
  options: RedirectPaymentOptions,
): RedirectPaymentRoutes {
  return {
    claims(pathname) {
      return (
        pathname === REDIRECT_START_PATH ||
        pathname === REDIRECT_RETURN_PATH ||
        pathname === REDIRECT_CALLBACK_PATH
      );
    },

    async fetch(request) {
      if (request.method !== "POST") {
        return refuse(
          405,
          "method-not-allowed",
          "Every route here is a POST: each carries a payment reference, and a reference belongs on a body rather than in a query string.",
        );
      }
      if (options.apiKey === "") return noStoreKey();

      const body = await readJson(request);
      if (body === undefined) {
        return refuse(400, "invalid", "Send a JSON object.");
      }

      const { pathname } = new URL(request.url);
      if (pathname === REDIRECT_START_PATH) return start(options, request, body);
      return settleRequest(options, request, body, pathname);
    },

    async settle(reference, request) {
      // The same refusal `fetch` makes, because this entry is reached without it: a route
      // mounted elsewhere in this Project settles through here, and a deployment with no
      // store key can no more place an Order for that caller than for a returning browser.
      if (options.apiKey === "") return noStoreKey();
      return settleByReference(options, request, reference);
    },
  };
}

/** This deployment was given no store API key, so it cannot place the Orders it settles. */
function noStoreKey(): Response {
  return refuse(
    503,
    "no-store-key",
    "This deployment was given no store API key, so it cannot place the Orders it settles. Pass a secret key from the Admin as `apiKey` where these routes are mounted — see src/server.ts.",
  );
}

/**
 * Start a payment for what the Cart comes to.
 *
 * **The amount is asked for rather than accepted from the caller**, and that is the point of the
 * route: a storefront that could name its own figure is a storefront whose bug the Merchant's
 * books pay for. `POST /store/carts/{id}/quote` runs this deployment's own pricing Steps, so the
 * figure the Shopper authorises is the figure kobai will charge (ADR-0077).
 *
 * **`metadata` is the one thing the storefront does say**, and it is not an amount: it is
 * ADR-0013's open context — a lead time, a customer tier, whatever this deployment's Steps price
 * on — sent here so the quote runs with it, and recorded on the payment so the placement runs
 * with it too. A quote and a placement given different contexts are two figures for one
 * purchase.
 */
async function start(
  options: RedirectPaymentOptions,
  request: Request,
  body: Record<string, unknown>,
): Promise<Response> {
  const cartId = typeof body.cartId === "string" ? body.cartId : "";
  if (cartId === "") {
    return refuse(400, "invalid", "`cartId` is required: name the Cart being paid for.");
  }
  const asked = body.metadata;
  if (asked !== undefined && (typeof asked !== "object" || asked === null)) {
    return refuse(400, "invalid", "`metadata`, if you send one, is an object.");
  }
  const metadata = (asked ?? {}) as Readonly<Record<string, unknown>>;

  const quoted = await options.kobai.fetch(
    // Encoded, because this is a caller's string in a path: an identifier carrying a `?` would
    // otherwise open a query string on the request, and the query string is half of the open
    // context every Step of the quote can read (ADR-0013).
    new Request(
      new URL(`/store/carts/${encodeURIComponent(cartId)}/quote`, request.url),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ metadata }),
      },
    ),
  );
  const quote = await readJsonBody(quoted);
  if (
    !quoted.ok ||
    typeof quote.total !== "number" ||
    typeof quote.currency !== "string"
  ) {
    // Passed through rather than reworded: kobai has already said whether this Cart has expired,
    // been placed, or holds a line it can no longer price, and saying it again in this Project's
    // words would be a second vocabulary for one fact.
    return json(quoted.status, {
      error:
        typeof quote.error === "string"
          ? quote.error
          : "This Cart could not be quoted, so no payment was started for it.",
      reason: typeof quote.reason === "string" ? quote.reason : "not-quotable",
    });
  }

  let started: StartedRedirectPayment;
  try {
    started = await options.payments.startPayment({
      cartId,
      metadata,
      amount: quote.total,
      currency: quote.currency,
    });
  } catch (cause) {
    // **A provider that will not start a payment is answered, not thrown out of.** It is the
    // one call here that reaches somebody else's system, so it fails for reasons that are
    // ordinary — an unreachable API, a key that has been revoked, a context too large for the
    // provider to carry back (`@kobai/plugin-stripe` refuses that outright rather than
    // truncating it, since a payment quoted with a context and placed without one is two
    // figures for one purchase). No money has moved and no Order exists, so what the
    // storefront needs is the reason; a bare 500 from this Project would name nothing at all.
    return json(502, {
      error: `No payment was started for this Cart: ${cause instanceof Error ? cause.message : String(cause)}`,
      reason: "payment-not-started",
    });
  }

  return json(200, {
    cartId,
    reference: started.reference,
    redirectUrl: started.redirectUrl,
    amount: quote.total,
    currency: quote.currency,
  });
}

/**
 * The Shopper's return and the provider's callback, which differ in exactly one thing: how the
 * **reference** is read out of the request.
 *
 * The returning browser was handed one when the payment was started, so it sends it. The callback
 * carries whatever the provider sends, and the provider is the only thing that can read that —
 * which is why {@link RedirectPayments.referenceOfCallback} exists and why a callback about a
 * payment this Project never started is turned back rather than guessed at.
 *
 * **Everything else about the payment comes from the provider**, for both of them. See
 * {@link SettlingPayment}: it is what makes the two requests identical, which the one
 * `Idempotency-Key` they share requires.
 */
async function settleRequest(
  options: RedirectPaymentOptions,
  request: Request,
  body: Record<string, unknown>,
  pathname: string,
): Promise<Response> {
  const fromTheCallback = pathname === REDIRECT_CALLBACK_PATH;
  const reference = fromTheCallback
    ? options.payments.referenceOfCallback(body)
    : referenceReturned(body);

  if (reference === null) {
    // **Two refusals, because they are two different mistakes.** A storefront that posted a
    // return with no reference on it has a bug and is told which field it left out; a callback
    // the provider cannot recognise is an event about somebody else's money — a Store's payment
    // provider holds payments kobai never started — and guessing at one is how a stranger's
    // payment buys this Store's stock.
    return fromTheCallback
      ? refuse(
          400,
          "not-ours",
          "This says nothing about a payment this Project started, so nothing was settled.",
        )
      : refuse(
          400,
          "invalid",
          "Send `reference` — the value this Project answered with when the payment was started.",
        );
  }

  return settleByReference(options, request, reference);
}

/**
 * A reference, and everything else asked of the provider — what every caller ends up in.
 *
 * Separate from {@link settleRequest} because reading a reference out of a request is the
 * *only* thing a caller decides. A route mounted elsewhere in this Project — one that verifies
 * a provider's own signature, say — reaches this through
 * {@link RedirectPaymentRoutes.settle} and gets the identical call, which is what makes it the
 * same intention rather than a second implementation of one.
 */
async function settleByReference(
  options: RedirectPaymentOptions,
  request: Request,
  reference: string,
): Promise<Response> {
  const settling = await options.payments.paymentOf(reference);
  if (settling === null) {
    return refuse(
      404,
      "not-ours",
      "This provider has never heard of that payment, so nothing was settled.",
    );
  }

  return settleRedirectPayment(options, request, reference, settling);
}

/** What the Shopper's browser comes back with — the reference, on the body. */
function referenceReturned(body: Record<string, unknown>): string | null {
  const reference = typeof body.reference === "string" ? body.reference : "";
  return reference === "" ? null : reference;
}

/**
 * **The one call both paths make**, and the refund when kobai will not place it.
 *
 * The `Idempotency-Key` is {@link idempotencyKeyFor}'s, and the body is byte-identical from
 * either caller — which it has to be, because a key claimed for one body and reused for another
 * is refused as a reuse rather than answered with the Order (#102). That is why every field of
 * it but the reference is read back from the provider rather than taken from the request.
 *
 * **What is *not* refunded is as important as what is.** Every refusal the idempotency key makes
 * says that another request holds it — and the key names this payment and nothing else, so that
 * other request is this Project's other caller settling the very payment in hand. Giving the
 * money back there would refund a purchase the Shopper is about to be shown. A Cart that has
 * already become an Order is the same fact reached without a key. Everything else — a lapsed
 * hold, a declined confirmation, a Step saying no — is money at the provider that kobai wrote
 * nothing for, and it goes back.
 */
async function settleRedirectPayment(
  options: RedirectPaymentOptions,
  request: Request,
  reference: string,
  settling: SettlingPayment,
): Promise<Response> {
  const { cartId, metadata } = settling;

  const placed = await options.kobai.fetch(
    new Request(new URL("/store/orders", request.url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
        // Derived from the reference, so the return and the callback claim one key.
        "idempotency-key": idempotencyKeyFor(reference),
      },
      // The reference on the **body** half of the open context, never the query string (#138),
      // beside the context the payment was quoted with — so a Step that priced on a lead time
      // when the figure was worked out prices on the same one now (ADR-0077). Under the key
      // the *provider* reads it back by, which is the provider's to name and not this route's.
      body: JSON.stringify({
        cartId,
        metadata: { ...metadata, [options.payments.referenceKey]: reference },
      }),
    }),
  );

  const answer = await readJsonBody(placed);

  if (placed.ok) {
    return json(200, {
      settled: "placed",
      cartId,
      reference,
      orderId: answer.id,
      orderNumber: answer.number,
    });
  }

  const reason = typeof answer.reason === "string" ? answer.reason : "refused";
  if (reason.startsWith("idempotency-key-") || reason === "cart-placed") {
    // The other caller got here first and is placing, or has placed. Nothing to refund, and
    // nothing to say beyond that this one settled nothing.
    return json(202, { settled: "elsewhere", cartId, reference, reason });
  }

  if (placed.status >= 500) {
    // **A refusal is a decision; a 5xx is not, and refunding on one would be guessing.** kobai
    // takes the payment before it writes the Order and unwinds it itself when a later Step
    // fails (ADR-0036), so a run that broke after `take-payment` has *already* asked this
    // provider for the money back — and a second reversal on top of it is a real provider
    // giving a Shopper their money twice. What is true is that nobody knows where this one
    // stands, so it says so and leaves the money alone for a person to look at.
    return json(502, {
      settled: "unknown",
      cartId,
      reference,
      reason: "kobai-failed",
      error:
        "kobai could not answer, so this payment was neither placed nor given back here. Check the provider and this Order before doing anything else.",
    });
  }

  await options.payments.refundUnplacedPayment({ reference, cartId, refusal: reason });

  return json(placed.status, {
    settled: "refunded",
    cartId,
    reference,
    reason,
    error:
      typeof answer.error === "string"
        ? answer.error
        : "kobai would not place this Order, so the payment was given back.",
  });
}

/**
 * What kobai answered, as an object — `{}` for anything that is not one.
 *
 * kobai answers JSON for every outcome it has, including the ones it did not anticipate (#33),
 * so a body that will not parse is a proxy or an outage rather than a refusal. Reading it as
 * empty keeps that on the refusal path — which refunds — instead of throwing out of the route
 * and leaving the Shopper's money at the bank with nothing having decided anything.
 */
async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** kobai's own refusal shape, because a Project serving two things should not answer in two. */
function refuse(status: number, reason: string, error: string): Response {
  return json(status, { error, reason });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
