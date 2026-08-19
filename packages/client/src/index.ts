import createClient, { type Client, type Middleware } from "openapi-fetch";
import type { components, paths } from "./schema.ts";

/**
 * `@kobai/client` — kobai's HTTP surface, as TypeScript.
 *
 * Everything in `./schema.ts` is generated from `@kobai/core`'s `openapi.json`, which is
 * itself generated from the routes Core serves. So the types here are not a description of
 * kobai written by hand and kept up to date: they are the surface, two mechanical steps
 * removed, and a build fails when either step is out of date.
 *
 * ADR-0006 calls this "a first-class deliverable, not a convenience", and the reason is
 * ADR-0002: kobai ships no storefront, so for a Developer building one the API *is* the
 * product. A client that typed its responses as `unknown` would hand that Developer the
 * documentation and keep the guarantees.
 *
 * ```ts
 * const kobai = createKobaiClient({
 *   baseUrl: "https://shop.example.com",
 *   credential: { apiKey: process.env.KOBAI_API_KEY },
 * });
 *
 * const { data, error } = await kobai.GET("/store/variants/{id}/price", {
 *   params: { path: { id: variantId } },
 * });
 * // `error` is the union of every refusal the route declares, so branching on `reason`
 * // means narrowing first — a 500 carries no `reason`, and the types say so.
 * if (error) return renderUnavailable("reason" in error ? error.reason : "unavailable");
 * return renderPrice(data.price.amount, data.price.currency);
 * ```
 *
 * Only `createKobaiClient` and the types are hand-written. The wrapper exists to do the one
 * thing the description cannot express — attach a credential — and nothing else: every
 * path, parameter, body and response comes from the generated `paths`.
 */

/** Everything `openapi-fetch` gives, over kobai's paths. `GET`, `POST`, `DELETE`, … */
export type KobaiClient = Client<paths>;

/**
 * The credential this client carries: an API key, and only an API key.
 *
 * This was a union of two, one per surface, while a Merchant session was a bearer token the
 * caller had to hold and re-present. Under ADR-0032 it is an httpOnly cookie: the browser
 * stores it and sends it back on every same-origin admin request without being asked, and
 * nothing in this package can read it or would be any use if it could. So the session is not
 * modelled here at all — not as an option, not as a type — and what is left is the one
 * credential a caller genuinely has to carry.
 *
 * That leaves `/admin` reachable from this client in exactly the case it is meant to be
 * reached from: a browser on the same origin as the API (ADR-0010), where `fetch` defaults to
 * sending same-origin cookies and there is nothing to configure. A server-side script driving
 * `/admin` signs in and keeps the cookie itself, the way a browser does.
 */
export type KobaiCredential = {
  /** An API key — `kobai_pk_…` or `kobai_sk_…`. Opens `/store`. */
  readonly apiKey: string;
};

export type KobaiClientOptions = {
  /** Where kobai is served, e.g. `https://shop.example.com`. */
  readonly baseUrl: string;
  /**
   * Presented as `Authorization: Bearer …` on every request.
   *
   * Optional, and omitted entirely by an Admin: `/store` is what a key opens, and `/admin` is
   * opened by the session cookie the browser carries. Exactly one admin route is reachable
   * with no credential at all — `POST /admin/session`, which is how a session is obtained in
   * the first place. A deployment's first Merchant is seeded when it boots and cannot be
   * created over HTTP at all.
   */
  readonly credential?: KobaiCredential;
  /**
   * The `fetch` to dispatch with. Defaults to the platform's.
   *
   * Given a kobai instance's own `fetch`, a test drives this client against the real
   * application with no port and no process — which is how `client.test.ts` proves the
   * generated types describe what the server actually answers.
   */
  readonly fetch?: (request: Request) => Response | Promise<Response>;
};

export function createKobaiClient(options: KobaiClientOptions): KobaiClient {
  const dispatch = options.fetch;
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    // Awaited here rather than demanded of the caller, so a `Kobai`'s own `fetch` — which
    // may answer synchronously — can be handed over as it is.
    ...(dispatch ? { fetch: async (request: Request) => dispatch(request) } : {}),
  });

  const credential = options.credential;
  if (credential) {
    const authorise: Middleware = {
      onRequest: ({ request }) => {
        request.headers.set("authorization", `Bearer ${credential.apiKey}`);
        return request;
      },
    };
    client.use(authorise);
  }

  return client;
}

/**
 * The description's named schemas, under the names it gives them.
 *
 * Re-exported one by one rather than as a bag, so that a name disappearing from the API is
 * a build failure here rather than a `never` somewhere downstream.
 *
 * One by one is also how the list goes stale, and it did: five of twelve refusal families
 * were named here while the rest were reached through `components`, which works and is the
 * indirection these lines exist to remove (#196). So the refusal half is no longer kept by
 * hand — `refusals.test.ts` reads every family out of the description and fails naming any
 * that is missing or exported under some other name. **Adding a refusal family to Core means
 * adding a line here**, and the build says so.
 */
export type Health = components["schemas"]["Health"];
export type MigrationState = components["schemas"]["MigrationState"];
export type Store = components["schemas"]["Store"];
export type Product = components["schemas"]["Product"];
export type ProductDetail = components["schemas"]["ProductDetail"];
export type Variant = components["schemas"]["Variant"];
/**
 * What a **storefront** is shown, which is deliberately less than a Merchant is.
 *
 * Declared apart from {@link Product}, {@link ProductDetail} and {@link Variant} rather than
 * reusing them: a publishable key is shipped to a browser, so these three are public, and a
 * field a Merchant needs must not be published by the deploy that adds it. A `StoreVariant`
 * therefore carries no stock count and no Price rows — ask `GET /store/variants/{id}/price`
 * for what one costs, because a Price is resolved by a Workflow rather than read off a row.
 */
export type StoreProduct = components["schemas"]["StoreProduct"];
export type StoreProductDetail = components["schemas"]["StoreProductDetail"];
export type StoreVariant = components["schemas"]["StoreVariant"];
export type FulfilmentStrategySummary =
  components["schemas"]["FulfilmentStrategySummary"];
export type Price = components["schemas"]["Price"];
export type Order = components["schemas"]["Order"];
export type OrderSummary = components["schemas"]["OrderSummary"];
export type Payment = components["schemas"]["Payment"];
/**
 * A Cart, and what a **Merchant's** list of them reports — the same shape either surface
 * answers with (ADR-0071).
 *
 * There is no `StoreCart` beside these the way there is a `StoreProduct`, and that asymmetry is
 * the safe direction of it: `Cart` is already the shape a publishable key reads, so a Merchant
 * reading one publishes nothing. What must not happen is the reverse — a Merchant-only field
 * added here would be published by the deploy that adds it.
 */
export type Cart = components["schemas"]["Cart"];
export type CartSummary = components["schemas"]["CartSummary"];
export type CartList = components["schemas"]["CartList"];
export type CartLineItem = components["schemas"]["CartLineItem"];
export type CartShopper = components["schemas"]["CartShopper"];
/**
 * What has become of a Cart, and the one thing the Merchant's list filters by.
 *
 * A **closed** set of three that partition the list: a Cart that became an Order is `spent`
 * whatever its deadline says, one that has not and is past its deadline is `expired`, and
 * everything else is `live`. A consumer that offers the filter can therefore hold this as a
 * union and be told by its compiler when a fourth arrives.
 */
export type CartState = components["schemas"]["CartState"];
export type Merchant = components["schemas"]["Merchant"];
export type Role = components["schemas"]["Role"];
export type Session = components["schemas"]["Session"];
export type IssuedApiKey = components["schemas"]["IssuedApiKey"];
export type ApiKeySummary = components["schemas"]["ApiKeySummary"];
export type ApiKeyKind = components["schemas"]["ApiKeyKind"];
export type ResolvedPrice = components["schemas"]["ResolvedPrice"];
export type StepReport = components["schemas"]["StepReport"];
// There is deliberately no `Refusal`. It was the one refusal type whose `reason` was a bare
// `string`, and ADR-0060 replaced it with the closed sets below — so a storefront narrows on
// the word it branches on rather than on `string`. The comment above is what caught the
// removal: a name leaving the API is a build failure here, which is the behaviour to keep.
export type InvalidRequest = components["schemas"]["InvalidRequest"];
export type InvalidCredentials = components["schemas"]["InvalidCredentials"];
export type MerchantRefusal = components["schemas"]["MerchantRefusal"];
export type RoleRefusal = components["schemas"]["RoleRefusal"];
export type StoreRefusal = components["schemas"]["StoreRefusal"];
export type CatalogRefusal = components["schemas"]["CatalogRefusal"];
export type StoreCatalogRefusal = components["schemas"]["StoreCatalogRefusal"];
export type CartRefusal = components["schemas"]["CartRefusal"];
export type CartReservations = components["schemas"]["CartReservations"];
export type HeldClaim = components["schemas"]["HeldClaim"];
export type CartReservationRefusal = components["schemas"]["CartReservationRefusal"];
export type OrderRefusal = components["schemas"]["OrderRefusal"];
export type PlaceOrderRequestRefusal = components["schemas"]["PlaceOrderRequestRefusal"];
export type ApiKeyNotFound = components["schemas"]["ApiKeyNotFound"];
export type SessionRefusal = components["schemas"]["SessionRefusal"];
export type ApiKeyRefusal = components["schemas"]["ApiKeyRefusal"];
export type PermissionDenied = components["schemas"]["PermissionDenied"];
export type SecretKeyRequired = components["schemas"]["SecretKeyRequired"];
// The last two are the ones that cannot be narrowed exhaustively, and each says so itself
// because a consumer meets the name rather than this comment. The shared argument, once:
// resolving a price and placing an Order both run a Workflow, and a Step a Project or a
// Plugin supplied is Extension Point 2 (ADR-0003) — it may refuse with a word Core has never
// heard of, which Core answers 422 because it cannot say what the word means. Closing either
// set here would close that Extension Point, so ADR-0060 leaves `reason` a bare `string` for
// exactly these two and closes every other family above.

/**
 * Why resolving a price was refused.
 *
 * **`reason` is an open string.** Core's own are `variant-not-found` and `price-not-set`,
 * listed in the field's own description; a Step this deployment supplied may refuse with
 * anything else. So a `switch` over it can never be exhaustive — write the arms for the words
 * you know and a default that shows `error`, which is prose, always present, and the only
 * thing that can be right about a word this build has never seen.
 */
export type PriceRefusal = components["schemas"]["PriceRefusal"];
/**
 * Why placing an Order was refused, with the account of the Workflow run beside it.
 *
 * **`reason` is an open string**, for the same reason {@link PriceRefusal}'s is. Core's own
 * are listed in the field's own description — `cart-expired`, `insufficient-inventory`,
 * `payment-declined` and the rest, which is where to read them rather than here, because a
 * count written down in prose is one more thing to keep in step. A Step this deployment
 * supplied may refuse with anything else. So this is the one refusal family a storefront
 * cannot exhaustively narrow, and the default arm showing `error` is not laziness: it is the
 * only correct answer for a refusal a Project wrote after this client was generated.
 */
export type PlaceOrderRefusal = components["schemas"]["PlaceOrderRefusal"];

/**
 * The generated surface itself, for anything the helpers above do not reach.
 *
 * `operations` is deliberately not among them: `openapi-typescript` keys it by
 * `operationId`, kobai's routes declare none, and re-exporting the empty record it produces
 * would be a name that resolves to nothing.
 */
export type { components, paths } from "./schema.ts";
