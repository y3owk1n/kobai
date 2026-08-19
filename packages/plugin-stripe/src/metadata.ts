/**
 * The two keys this Plugin reads and writes, and the one thing it does with them.
 *
 * A module of their own because both halves of the Plugin need them and neither owns them:
 * {@link ./payments.ts | the provider} writes the Cart onto an intent and reads the intent off
 * an order, and {@link ./refund-unplaced-payment.ts | the refund} writes the Cart again onto
 * what it gives back. Keeping them here is what stops those two importing each other.
 */

/**
 * The key the PaymentIntent's id travels under on `POST /store/orders`.
 *
 * ADR-0013's open context: everything the caller sent that Core does not model reaches a
 * provider verbatim in `PaymentRequest.metadata`, and this is the one key this Plugin reads
 * out of it. Both callers send it — the Shopper's returning browser and the Project's webhook
 * route — because both are making the same kobai call (ADR-0070).
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
 * The key ADR-0013's **open context** travels under in a PaymentIntent's `metadata`, as JSON.
 *
 * **Stripe's metadata values are strings and the open context is not**, so a decision had to
 * be taken about how one is carried in the other, and this is it: the whole context is
 * `JSON.stringify`d into one value rather than flattened into a key per field.
 *
 * Flattening was the alternative and it is worse in every direction. The context is a bag Core
 * never interprets — a lead time, a customer tier, a printer's name, an object of objects — so
 * flattening it would mean inventing a nesting convention, a type convention and an escaping
 * convention for keys Stripe caps at forty characters, and then reading all three back. One
 * value needs none of that: what went in comes out, numbers as numbers, and the only rule is
 * Stripe's own {@link STRIPE_METADATA_VALUE_LIMIT}.
 *
 * **Why it has to travel at all.** The payment is quoted with the context and must be *placed*
 * with the same one, or a Step that prices on it works out two figures for one purchase and
 * the Shopper has already authorised the first (ADR-0077). Neither settling caller can carry
 * it: the returning browser could send anything and the webhook has only what Stripe holds, so
 * the payment is the one place both can read it from.
 */
export const STRIPE_CONTEXT_KEY = "kobaiContext";

/**
 * What Stripe holds in one metadata value — 500 characters, as its API reference documents.
 *
 * Written down here because a context that does not fit is a payment this Plugin **refuses to
 * start**: truncating would quote a purchase with a context and place it without one, which is
 * the disagreement the context is carried to prevent.
 */
export const STRIPE_METADATA_VALUE_LIMIT = 500;

/**
 * The open context as one Stripe metadata value, or `undefined` for a purchase that carried
 * none.
 *
 * Throws for a context Stripe would not carry back — see {@link STRIPE_METADATA_VALUE_LIMIT}.
 * A bag that will not serialise at all (a `BigInt`, a circular reference) throws out of
 * `JSON.stringify` on its own, which is the same answer for the same reason.
 */
export function stripeContextValue(
  context: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (context === undefined || Object.keys(context).length === 0) return undefined;

  const encoded = JSON.stringify(context);
  if (encoded.length > STRIPE_METADATA_VALUE_LIMIT) {
    throw new Error(
      `This payment's context is ${encoded.length} characters and Stripe holds ${STRIPE_METADATA_VALUE_LIMIT} in a metadata value, so it would not have come back with the payment. Send the storefront's own key for it and keep what a Step prices on small enough to travel.`,
    );
  }
  return encoded;
}

/**
 * The open context a PaymentIntent was created with — `{}` for one that carried none.
 *
 * **A value that will not parse reads as none rather than throwing**, and that is safe because
 * it is not the last check. This Plugin is what writes the value, so a broken one means
 * somebody edited the intent in Stripe's dashboard; settling with the context kobai can
 * actually read then produces a total that disagrees with the money at the bank whenever a
 * Step priced on what is missing, and `charge` declines a payment for a figure that is not the
 * Order's (ADR-0077) — so the Shopper is refunded rather than sold something at a price nobody
 * authorised.
 */
export function contextOfPaymentIntent(
  intent: unknown,
): Readonly<Record<string, unknown>> {
  const value = metadataOf(intent)?.[STRIPE_CONTEXT_KEY];
  if (typeof value !== "string" || value === "") return {};

  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

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
  const cartId = metadataOf(intent)?.[STRIPE_CART_ID_KEY];
  return typeof cartId === "string" && cartId !== "" ? cartId : null;
}

/** A PaymentIntent's `metadata`, without believing an unread body is one. */
function metadataOf(intent: unknown): Record<string, unknown> | undefined {
  if (typeof intent !== "object" || intent === null) return undefined;
  const metadata = (intent as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) return undefined;
  return metadata as Record<string, unknown>;
}
