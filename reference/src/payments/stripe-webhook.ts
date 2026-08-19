import { createHmac, timingSafeEqual } from "node:crypto";
import { consoleLogger, type Logger } from "@kobai/core";
import type { ProjectRoutes } from "../app.ts";

/**
 * **Where Stripe tells this Project that a bank answered** (ADR-0070).
 *
 * A Plugin cannot add a route — routes are not one of ADR-0003's five Extension Points — and
 * here that is a feature rather than a limitation. Signature verification is a deployment's
 * own trust decision, its logs are its own, and a bank that does something nobody anticipated
 * is the deployment's to handle. So `@kobai/plugin-stripe` says which payment an event is
 * about, and everything else on this path belongs to the Project: this file, and the
 * {@link ../payments/redirect.ts | redirect routes} it settles through.
 *
 * **It settles through the very call the Shopper's return makes** —
 * {@link RedirectPaymentRoutes.settle}, `POST /store/orders` with an `Idempotency-Key` derived
 * from the payment reference — so the two never have to know about each other and either may
 * be the one that wins. That is the whole design: the ordinary case in Malaysia is that the
 * Shopper authorises in a banking app and never comes back to the tab, and this is the caller
 * that always arrives.
 *
 * **Nothing happens before the signature verifies.** The body is not parsed, Stripe is not
 * asked about the payment and kobai hears nothing — because anybody who can post a
 * `payment_intent.succeeded` at this path without the signing secret can buy a Store's stock
 * with a Cart they built themselves.
 */

/** Where this Project listens for Stripe. Nothing under it is kobai's surface. */
export const STRIPE_WEBHOOK_PATH = "/webhooks/stripe";

/**
 * How far a request's timestamp may be from now — five minutes, which is what Stripe's own
 * libraries take.
 *
 * The timestamp is signed along with the body precisely so that a captured request cannot be
 * replayed later, and a tolerance is what makes that check possible at all: two clocks never
 * agree exactly, and a webhook crosses the internet.
 */
export const STRIPE_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

export type StripeWebhookOptions = {
  /** Stripe's signing secret for this endpoint — `whsec_…`, from the deployment's environment. */
  readonly secret: string;
  /**
   * Which payment an event is about, or `null` for one that settles nothing —
   * `@kobai/plugin-stripe`'s `paymentIntentIdOfEvent`.
   *
   * The Plugin's job rather than this route's: what an event *is* is Stripe's shape, and a
   * Project should not have to learn it to mount a route.
   */
  readonly referenceOf: (event: unknown) => string | null;
  /** The one call, from {@link RedirectPaymentRoutes.settle}. */
  readonly settle: (reference: string, request: Request) => Promise<Response>;
  /** This deployment's own log — the half of a webhook a Plugin could never own. */
  readonly logger?: Logger;
  /** Overridden only by a test that has to stage a clock; see {@link STRIPE_SIGNATURE_TOLERANCE_MS}. */
  readonly now?: () => number;
};

export function createStripeWebhookRoute(options: StripeWebhookOptions): ProjectRoutes {
  const logger = options.logger ?? consoleLogger;
  const now = options.now ?? (() => Date.now());

  return {
    claims: (pathname) => pathname === STRIPE_WEBHOOK_PATH,

    async fetch(request) {
      // The bytes that were sent, and never a body re-serialised from parsed JSON: the
      // signature is over exactly what crossed the wire, so anything else would verify a
      // string Stripe never signed — and would therefore accept a tampered one.
      const payload = await request.text();
      const verified = signatureVerifies({
        payload,
        header: request.headers.get("stripe-signature"),
        secret: options.secret,
        now: now(),
      });

      if (!verified) {
        // Logged, and this is the half of a webhook that could only ever be the deployment's:
        // a request nobody could have signed is either a Merchant who has rotated a secret
        // without telling this deployment, or somebody trying to buy a Store's stock with a
        // Cart they built themselves. Both are worth a line in a Merchant's own logs, and
        // neither can be inferred from the 400 the sender gets.
        logger.error("a request at Stripe's webhook did not verify", {
          reason:
            "its signature is not this deployment's, or its timestamp is too far from now, so nothing was read out of it and nothing was settled",
        });
        return json(400, {
          error:
            "This request was not signed by the Stripe account this deployment holds the secret for, so nothing was settled.",
          reason: "signature-invalid",
        });
      }

      const reference = options.referenceOf(parse(payload));
      if (reference === null) {
        // **Acknowledged, not refused.** A Merchant's Stripe account holds payments kobai
        // never started and events that mean nothing here, and a 4xx is Stripe's signal to
        // deliver again — for three days, about a payment that will never be any of kobai's
        // business.
        return json(200, {
          settled: "nothing",
          reason: "not-ours",
          error: "This event is not about a payment this Store started.",
        });
      }

      const settled = await options.settle(reference, request);

      if (settled.status >= 500) {
        // **The one answer Stripe should deliver again**, and it is passed back untouched —
        // including its status, and without reading its body, because a settlement that broke
        // is exactly the one that may not have a body to read. Nobody knows where this payment
        // stands (the same case `redirect.ts` describes), and another delivery is another
        // chance to find out, which no other outcome here would be.
        logger.error("Stripe's webhook could not settle a payment", {
          reference,
          status: settled.status,
        });
        return settled;
      }

      // Everything else is a conclusion: placed, placed by the Shopper's return already, or
      // refused and refunded. Delivering it again would reach the same one.
      const outcome = await readJsonBody(settled);
      logger.info("Stripe's webhook settled a payment", { reference, outcome });
      return json(200, outcome);
    },
  };
}

/**
 * Whether this request was signed by the Stripe account this deployment holds the secret for.
 *
 * Stripe sends `t=<unix seconds>,v1=<hex hmac>` and signs `"<t>.<payload>"` with the endpoint's
 * secret. Three things about the check are load-bearing:
 *
 * - **The timestamp is inside the signature**, so a captured request cannot be replayed with a
 *   fresh one; and it is compared against a tolerance, because two clocks never agree exactly.
 * - **Every `v1` is tried.** Stripe sends more than one while a secret is being rotated, and a
 *   check that read only the first would fail every request for the length of a rotation.
 * - **The comparison is `timingSafeEqual`.** A byte-by-byte compare that returns early leaks
 *   how much of a guess was right, which is enough to forge a signature given enough tries.
 */
function signatureVerifies({
  payload,
  header,
  secret,
  now,
}: {
  payload: string;
  header: string | null;
  secret: string;
  now: number;
}): boolean {
  if (header === null || secret === "") return false;

  const parts = header.split(",").map((part) => part.split("=", 2));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts
    .filter(([key]) => key === "v1")
    .map(([, value]) => value ?? "");
  if (timestamp === undefined || signatures.length === 0) return false;

  const at = Number(timestamp);
  if (!Number.isFinite(at)) return false;
  // Both directions: a timestamp far in the future is no more this request's than one far in
  // the past, and it is what a clock skewed the other way looks like.
  if (Math.abs(now - at * 1000) > STRIPE_SIGNATURE_TOLERANCE_MS) return false;

  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex"),
  );

  return signatures.some((signature) => {
    const given = Buffer.from(signature);
    // `timingSafeEqual` throws on differing lengths, which is itself a length comparison —
    // and a harmless one: a hex digest's length is fixed and public.
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** The event, as an object — `null` for anything that is not one, which settles nothing. */
function parse(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * What the settlement answered, as an object — `{}` for anything that is not one.
 *
 * Read rather than trusted for the same reason `redirect.ts` reads kobai's own answers that
 * way: a body that will not parse is a proxy or an outage rather than a decision, and throwing
 * here would turn a settled payment into a webhook Stripe keeps re-delivering.
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

/** kobai's own answer shape, because a Project serving two things should not answer in two. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
