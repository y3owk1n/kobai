import { createPlaygroundClient } from "@/lib/kobai";
import { messageOf, reasonOf } from "@/lib/refusal";

/**
 * The Playground's request seam — **the only file in this Admin that builds a kobai path at
 * runtime**, and the only one with a cast in it (ADR-0081, #269).
 *
 * Everywhere else, a call to kobai names a **literal** path and `@kobai/client` types the
 * parameters, the body and every response against it. This screen cannot: the path it sends at
 * was read out of a document the server served a moment ago, so no compiler has anything to
 * check it against, and some cast is unavoidable for a playground driven by a runtime
 * description.
 *
 * **The cast lives here and never in `@kobai/client`.** That package sells itself on every call
 * it types being a call that exists (ADR-0006), and an untyped escape hatch on it would be a
 * hole every consumer inherits to serve one screen.
 * `tests/admin-uses-only-the-public-api.test.ts` names this file as the only one allowed to do
 * it and fails naming any other — without that assertion its existing scan, which reads
 * **quoted** path literals, would be silently vacuous over the one screen in the Admin that can
 * reach anything.
 *
 * ## `credentials: "omit"` is the whole of this module
 *
 * `kobai_session` names no `Path`, so RFC 6265 files it under the default-path `/admin` and the
 * browser attaches it to **every** request to that subtree — regardless of which page sent it,
 * and regardless of any `Authorization` header the sender also set (ADR-0032). So a Developer
 * who selects a publishable key and sends `GET /admin/products` would get 200 and a list of
 * Products, and would learn that a `kobai_pk_…` opens the admin surface. It does not, and a tool
 * that answers a different question from the one asked is worse than no tool.
 *
 * With the cookie omitted the inverse becomes true and valuable: a `/store` call made with a
 * publishable key behaves **exactly** as a storefront's would, including failing the same way —
 * `POST /store/orders` answers `secret-key-required` (ADR-0055), which is the entire reason to
 * build the screen.
 *
 * ## What this deliberately does not do
 *
 * **Nothing is validated.** The body is the text a Developer typed, sent byte for byte, because
 * `InvalidRequest` is modelled and promised (ADR-0060) and a refused body renders the real rule
 * from the authority that owns it. A JSON-Schema validator here would be a second copy of a
 * Core rule, in the tree `kobai-upgrade` can never reach.
 *
 * **It predicts no refusal.** Every operation is sendable on every credential; whether the one
 * chosen may perform it is Core's answer to give.
 */

/**
 * The credential a request carries, and the one decision this module turns on.
 *
 * Two cases rather than three, because the difference that matters here is not which *kind* of
 * key was chosen but whether the ambient cookie is allowed to travel. Which of the two key
 * kinds it is, and how each is come by — the publishable one the Admin already holds, the
 * secret one held in memory for one request — is the screen's business and is decided in
 * `screens/playground.tsx`.
 */
export type PlaygroundCredential =
  /** This Merchant's own Session: the cookie the browser holds, and the only ambient one. */
  | { readonly kind: "session" }
  /** An API key, presented as a bearer, with the ambient cookie suppressed. */
  | { readonly kind: "key"; readonly apiKey: string };

/** One request, composed on the screen out of the description and what a Developer typed. */
export type PlaygroundRequest = {
  /** Upper case, the way a request line spells it. */
  readonly method: string;
  /** The **templated** path, exactly as the description spells it: `/admin/products/{id}`. */
  readonly path: string;
  /** What fills each `{…}`, by the name the description gives it. */
  readonly pathParameters: Readonly<Record<string, string>>;
  /** What goes in the query string. A blank one is not sent at all — see below. */
  readonly queryParameters: Readonly<Record<string, string>>;
  /**
   * What goes in a header the description declares — `idempotency-key` is the one kobai has.
   *
   * A parameter the description declares and this screen dropped would be an operation a
   * Developer cannot send properly, with nothing on screen saying so. A `cookie` parameter is
   * the one location deliberately not offered: no script in a browser can set one, and kobai
   * declares none.
   */
  readonly headerParameters: Readonly<Record<string, string>>;
  /** The body, exactly as typed, or `undefined` where the operation takes none. */
  readonly body: string | undefined;
  /** What the description says the body is, which is what it is sent as. */
  readonly mediaType: string | undefined;
  readonly credential: PlaygroundCredential;
};

/** What kobai answered — the whole of it, told apart by nothing this Admin decided. */
export type PlaygroundAnswer = {
  readonly status: number;
  /** At or above 400. The line a caller acts on, and the same one `isRefusal` draws. */
  readonly refused: boolean;
  /** The body as kobai sent it, indented where it is JSON and untouched where it is not. */
  readonly body: string;
  /** The `reason` a refusal carries — the word a storefront branches on. */
  readonly reason: string | undefined;
  /** The prose a refusal carries, which is what `error` always is. */
  readonly message: string | undefined;
  /** How long it took, wall clock, rounded to the millisecond. */
  readonly milliseconds: number;
};

/**
 * `openapi-fetch`'s own `request`, with the types that make it refuse a runtime path taken off.
 *
 * The one cast in this Admin. It widens the path and the method to strings and the result to
 * what this module reads, and it widens **nothing else**: the call underneath is the same one
 * every typed call in this Admin makes, so a request composed here travels the same middleware,
 * the same serializers and the same base URL.
 */
type UntypedRequest = (
  method: string,
  path: string,
  init: Record<string, unknown>,
) => Promise<{
  readonly response: Response;
  readonly data?: unknown;
  readonly error?: unknown;
}>;

/**
 * Sends it, and answers with what came back rather than throwing on a refusal.
 *
 * A refusal is the **answer** here and not a failure: it is most of what a Developer opened
 * this screen to see. What does reject is the request never arriving at all — the network being
 * gone — which is the one thing kobai has no words for.
 */
export async function sendPlaygroundRequest(
  request: PlaygroundRequest,
): Promise<PlaygroundAnswer> {
  const client = createPlaygroundClient(
    request.credential.kind === "key" ? request.credential.apiKey : undefined,
  );
  const send = client.request as unknown as UntypedRequest;

  const started = performance.now();
  const { response, data, error } = await send(request.method, request.path, {
    params: {
      // Every declared path parameter, blank ones included: a key left out entirely leaves
      // `{id}` standing in the URL, which is a stranger thing to send than the empty segment a
      // Merchant who typed nothing meant. A blank **query** parameter is the opposite — a form
      // field nobody filled in is a parameter nobody passed — so those are dropped.
      path: request.pathParameters,
      query: given(request.queryParameters),
      header: given(request.headerParameters),
    },
    ...(request.body === undefined
      ? {}
      : {
          body: request.body,
          // The text as typed, byte for byte. The default serializer would `JSON.stringify` it
          // and send a JSON *string* holding the document, and an invalid body — which is a
          // thing a Developer comes here to send on purpose — would never reach kobai as the
          // thing they typed.
          bodySerializer: (body: unknown) => body,
        }),
    ...(request.mediaType === undefined
      ? {}
      : { headers: { "content-type": request.mediaType } }),
    // Read as text rather than as JSON, because what this screen shows is the body kobai sent
    // and not an object this Admin re-rendered — including a body that is not JSON at all.
    parseAs: "text",
    // **The load-bearing line.** Written as a value on every request rather than as a
    // conditional spread, so that neither branch can be read as an oversight: the Session is
    // the one credential the browser may attach by itself, and everything else travels alone.
    credentials: request.credential.kind === "session" ? "same-origin" : "omit",
  });
  const milliseconds = Math.round(performance.now() - started);

  const body = indented(textOf(data, error));
  const refused = response.status >= 400;
  // Read out of the body only where the status says this **is** a refusal: an answer that
  // happens to carry a field called `reason` is not one, and rendering it as one would put a
  // refusal a Developer never met on a screen whose whole subject is the real answer.
  const parsed = refused ? jsonIn(body) : undefined;
  // `messageOf` always answers a string, so an empty fallback is how "kobai sent no prose of
  // its own" is asked for — which is what a 500 does, deliberately (ADR-0060).
  const message = messageOf(parsed, "");

  return {
    status: response.status,
    refused,
    body,
    reason: reasonOf(parsed),
    message: message === "" ? undefined : message,
    milliseconds,
  };
}

/** The entries somebody actually filled in — a blank field is a parameter nobody passed. */
function given(parameters: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(parameters).filter(([, value]) => value !== ""),
  );
}

/**
 * The body, whichever half of the result it arrived in.
 *
 * `openapi-fetch` reports a 2xx under `data` and everything else under `error`, and with
 * `parseAs: "text"` the first is a string — while the second is the text *parsed* where it
 * happened to be JSON, which is that library's own convenience and not something to build on.
 * Both are `undefined` for a 204 and for a `HEAD`, where saying nothing is what the answer says.
 */
function textOf(data: unknown, error: unknown): string {
  const held = data ?? error;
  if (held === undefined) return "";
  return typeof held === "string" ? held : JSON.stringify(held);
}

/** The same text, indented where it is JSON — and returned untouched where it is not. */
function indented(text: string): string {
  const parsed = jsonIn(text);
  return parsed === undefined ? text : JSON.stringify(parsed, null, 2);
}

/** The value a body holds, or `undefined` where the body is not JSON at all. */
function jsonIn(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
