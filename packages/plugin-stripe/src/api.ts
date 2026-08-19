/**
 * The whole of this Plugin's contact with the outside world: one function, over `fetch`.
 *
 * **There is no Stripe SDK here on purpose.** Three REST calls is not enough to earn a
 * dependency that brings its own HTTP client, its own Node expectations and its own release
 * cadence into every Project that takes card payments — and, decisively, it is what makes
 * `devbox run ci` hermetic. The network is one option a caller may replace, so a test stubs
 * *all* of it with a `fetch` of its own and nothing in the gate needs a secret, a sandbox
 * account or a route to the internet (ADR-0070).
 *
 * The other half of that is what this module does **not** do: it never decides what an answer
 * means. It returns Stripe's status and Stripe's body, and whether a 402 is a decline a
 * Shopper should be shown or a bug a Developer should be paged for is
 * {@link ./payments.ts | the provider}'s to say — because that difference is kobai's
 * (`PaymentOutcome`), not Stripe's.
 */

/**
 * How this Plugin reaches Stripe. The one required value is the secret key.
 *
 * Every field is a Project's to set in `kobai.config.ts`, and the two optional ones exist for
 * the same reason: so that what this Plugin talks to is a decision the deployment makes rather
 * than a constant compiled into it.
 */
export type StripeOptions = {
  /**
   * The Stripe **secret** key this deployment charges with — `sk_live_…` or `sk_test_…`.
   *
   * Never a publishable key: it authorises creating and confirming payments and issuing
   * refunds, which is the same argument that keeps `POST /store/orders` off a browser's kobai
   * key (ADR-0055). A Project reads it from its own environment; this Plugin holds it and
   * sends it, and puts it nowhere else.
   */
  readonly secretKey: string;
  /**
   * Where Stripe is. Defaults to the real API.
   *
   * A Project pointing this at a recording proxy is the supported way to exercise the adapter
   * against captured traffic without changing a line of it.
   */
  readonly apiBaseUrl?: string;
  /**
   * The `fetch` every call goes through. Defaults to the runtime's own.
   *
   * This is the seam the gate is tested at, and it is public rather than internal because a
   * Project that wants a timeout, a retry policy or its own logging around Stripe supplies one
   * here instead of asking this Plugin for a setting per concern.
   */
  readonly fetch?: typeof globalThis.fetch;
};

/** A value a Stripe form parameter can carry. `undefined` is left off the wire entirely. */
type FormValue = string | number | boolean | undefined;

/** One level of nesting is all Stripe's `metadata[…]` and `automatic_payment_methods[…]` need. */
export type StripeForm = Readonly<
  Record<string, FormValue | Readonly<Record<string, FormValue>>>
>;

/** What Stripe puts in the `error` of a failed response, as much of it as this Plugin reads. */
export type StripeApiError = {
  /** `card_error`, `invalid_request_error`, `api_error`, … */
  readonly type?: string;
  /** `resource_missing`, `charge_already_refunded`, … */
  readonly code?: string;
  /** Stripe's own sentence about it. */
  readonly message?: string;
};

/**
 * What Stripe answered. Never a throw for an answer Stripe actually gave.
 *
 * A rejected `fetch` and a body that is not JSON *do* throw, because neither is Stripe
 * answering — they are the network or something in front of it, which is the case
 * `PaymentProvider.charge` says travels as the 500 it is.
 */
export type StripeResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly status: number; readonly error: StripeApiError };

const DEFAULT_API_BASE_URL = "https://api.stripe.com";

export type StripeCall = {
  readonly method: "GET" | "POST";
  /** Absolute on the API's origin, `/v1/…`. */
  readonly path: string;
  readonly form?: StripeForm;
  /**
   * Stripe's `Idempotency-Key`, for a call that must not happen twice.
   *
   * Sent on every call that moves or commits money and on none that only reads, because
   * Stripe replays the *first* response for a repeated key — which is the whole point for a
   * refund and would be a trap for a create whose amount had changed in between.
   */
  readonly idempotencyKey?: string;
};

export async function callStripe(
  options: StripeOptions,
  call: StripeCall,
): Promise<StripeResult> {
  const url = new URL(call.path, options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.secretKey}`,
    // Stripe's API takes form encoding, not JSON, on every endpoint this Plugin uses.
    "content-type": "application/x-www-form-urlencoded",
  };
  if (call.idempotencyKey !== undefined) headers["idempotency-key"] = call.idempotencyKey;

  const response = await (options.fetch ?? globalThis.fetch)(url, {
    method: call.method,
    headers,
    body: call.method === "GET" ? undefined : encodeForm(call.form ?? {}),
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    // Not Stripe disagreeing — Stripe answers JSON for everything, including its errors. A
    // proxy, an outage page or a truncated response lands here, and it is an outage rather
    // than a decline.
    throw new Error(
      `Stripe answered ${response.status} to ${call.method} ${call.path} with something that is not JSON.`,
      { cause },
    );
  }

  const object = isRecord(body) ? body : {};
  if (response.ok) return { ok: true, body: object };

  const error = isRecord(object.error) ? object.error : {};
  return {
    ok: false,
    status: response.status,
    error: {
      type: stringOrUndefined(error.type),
      code: stringOrUndefined(error.code),
      message: stringOrUndefined(error.message),
    },
  };
}

/**
 * Stripe's form encoding, for the one level of nesting this Plugin sends.
 *
 * `metadata[kobaiCartId]=…` rather than JSON, because that is what Stripe's API takes.
 */
function encodeForm(form: StripeForm): string {
  const parameters = new URLSearchParams();

  for (const [key, value] of Object.entries(form)) {
    if (value === undefined) continue;
    if (typeof value === "object") {
      for (const [nested, inner] of Object.entries(value)) {
        if (inner === undefined) continue;
        parameters.set(`${key}[${nested}]`, String(inner));
      }
      continue;
    }
    parameters.set(key, String(value));
  }

  return parameters.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a field Stripe documents as a string, without believing that it is one. */
export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Read a field Stripe documents as an integer, without believing that it is one. */
export function integerOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
