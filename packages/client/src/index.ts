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
export type Deployment = components["schemas"]["Deployment"];
export type DeployedWorkflow = components["schemas"]["DeployedWorkflow"];
export type DeployedStep = components["schemas"]["DeployedStep"];
/**
 * Where the Step in a Workflow position came from — `stock`, `replaced` or `inserted`.
 *
 * **Not derivable from the two fields beside it.** `slot` and `step` are equal for a Core
 * default, for an inserted Step, and for a replacement that answers to the slot's own name, so
 * a client comparing them reads two customised deployments as stock (ADR-0080).
 */
export type StepOrigin = components["schemas"]["StepOrigin"];
/**
 * This deployment's own OpenAPI description — an **open object**, deliberately.
 *
 * An OpenAPI document is a recursive schema kobai does not own, so it is not modelled here:
 * hand it to a tool that already knows the shape.
 */
export type OpenApiDescription = components["schemas"]["OpenApiDescription"];
export type Store = components["schemas"]["Store"];
export type Product = components["schemas"]["Product"];
export type ProductDetail = components["schemas"]["ProductDetail"];
export type Variant = components["schemas"]["Variant"];
/**
 * The two halves of a picker, and the reason there is no route that resolves a combination.
 *
 * A {@link ProductDetail} carries its `options` **in the order the Merchant put them in**, and
 * each {@link Variant} carries its value for each — so a storefront maps a chosen combination to
 * a SKU by zipping the two, and a combination no Variant answers is simply absent rather than an
 * error to interpret. Both are keyed by the option's **name**, which is unique within a Product;
 * the identifier on a `ProductOption` exists so that `PATCH /admin/products/{id}` can rename one
 * without losing its values, which is why {@link StoreProductOption} does not carry it.
 */
export type ProductOption = components["schemas"]["ProductOption"];
export type VariantOptionValue = components["schemas"]["VariantOptionValue"];
/** One option a create declares — a name, and its place in the list it arrived in. */
export type ProductOptionDeclaration = components["schemas"]["ProductOptionDeclaration"];
/** One entry of a correction: `id` present is identity, `id` absent is a new option. */
export type ProductOptionCorrection = components["schemas"]["ProductOptionCorrection"];
/**
 * Whether a Shopper may see a Product, and the one thing a Merchant's Product list filters by.
 *
 * A **closed** set of three that partition the catalog: a `draft` is being prepared, a
 * `published` Product is what the store surface answers with, and an `archived` one has left the
 * storefront without taking the Orders that reference it with it. A consumer that offers the
 * filter can therefore hold this as a union and be told by its compiler when a fourth arrives.
 *
 * It is on {@link Product} and {@link ProductDetail} and deliberately on neither store shape —
 * see below.
 */
export type ProductStatus = components["schemas"]["ProductStatus"];
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
export type StoreProductOption = components["schemas"]["StoreProductOption"];
export type StoreVariantOptionValue = components["schemas"]["StoreVariantOptionValue"];
/**
 * One image, as a storefront is shown it — and what it drops is everything about the *file*.
 *
 * Declared apart from {@link Media} for the reason above it: `filename` is what the image was
 * called on a Merchant's own machine, and `contentType` and `byteSize` are facts the thing
 * fetching the bytes is told by the response that carries them. What is left is what a page lays
 * out with — the address, the alt text, and the two dimensions.
 */
export type StoreMedia = components["schemas"]["StoreMedia"];
export type FulfilmentStrategySummary =
  components["schemas"]["FulfilmentStrategySummary"];
export type Price = components["schemas"]["Price"];
/**
 * One row of `GET /admin/prices` — a Price, and the Variant it prices (#310).
 *
 * Declared apart from {@link Price} rather than as that shape with a field added: a Price nested
 * under the Variant it belongs to has no use for a copy of it. **The pair of identifiers is what
 * this is for** — `variant.id` and the Price's own `id` are what `DELETE
 * /admin/variants/{id}/prices/{priceId}` takes, so a Price found by asking which apply to a
 * Region can be removed without opening the Product it hangs under.
 *
 * `region` and `channel` are the constraints the row **names**, and `null` on either means it
 * applies to all of them. Which Price a Shopper is actually charged is best match rather than a
 * row read — `GET /store/variants/{id}/price`.
 */
export type ListedPrice = components["schemas"]["ListedPrice"];
export type PriceList = components["schemas"]["PriceList"];
/**
 * A Merchant-supplied catalog asset, and the address it is served at (ADR-0015).
 *
 * **`url` is the whole of what a client is told about where the bytes are**, and it may be
 * absolute or root-relative: it is the deployment's own `MediaStorage`'s answer, so a Store on a
 * CDN answers `https://…` and one on the storage kobai ships answers `/media/{key}`, which is
 * kobai's own open byte route. It is asked of that storage on every read rather than stored, so
 * a Store that moves its bucket moves every Media with it and nothing here goes stale.
 *
 * `width` and `height` are `null` for a format kobai cannot read a header from — `null` rather
 * than `0`, so a storefront reserving space can tell *unknown* from a measurement.
 */
export type Media = components["schemas"]["Media"];
export type MediaList = components["schemas"]["MediaList"];
/** The `multipart/form-data` an upload sends: the file part, and optional alt text. */
export type UploadMediaRequest = components["schemas"]["UploadMediaRequest"];
/**
 * One entry of the list saying what a Product or a Variant shows.
 *
 * The whole list is sent, in the order it should be shown in, so attaching, reordering and
 * detaching are one request; an empty list detaches everything. **Detaching does not delete the
 * Media** — it stays in the Store's library and may still be showing elsewhere (ADR-0082).
 */
export type MediaAttachment = components["schemas"]["MediaAttachment"];
/**
 * A **Collection** — a Merchant's grouping of Products, so a storefront has navigation.
 *
 * A title, and no handle: nothing resolves a Collection by name, because a storefront browses
 * one through `GET /store/products?collection=` by the `id` each Product's own `collections`
 * reports. Titles are not unique — a Collection is addressed by its identifier everywhere.
 *
 * `StoreCollection` is what a publishable key reads and carries the same three fields, declared
 * apart so a field added for a Merchant is not published by the deploy that adds it.
 */
export type Collection = components["schemas"]["Collection"];
export type CollectionList = components["schemas"]["CollectionList"];
export type StoreCollection = components["schemas"]["StoreCollection"];
export type CreateCollectionRequest = components["schemas"]["CreateCollectionRequest"];
export type UpdateCollectionRequest = components["schemas"]["UpdateCollectionRequest"];
/**
 * One entry of the set saying which Collections a Product is in.
 *
 * The whole set is sent, so grouping and ungrouping are one request and an empty list takes the
 * Product out of every Collection. Unlike `MediaAttachment` the **order carries no meaning**: a
 * Product is in a Collection or it is not, and a read answers by title.
 */
export type CollectionMembership = components["schemas"]["CollectionMembership"];
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
/**
 * What a Cart comes to, as at one instant (ADR-0077).
 *
 * The figure a storefront starts a bank-redirect payment for, and the one shape here that is
 * deliberately **not** a record of anything: nothing was written, nothing is held, and there is
 * no identifier on it to send back. `quotedAt` is the whole of what it promises.
 */
export type Quote = components["schemas"]["Quote"];
export type QuoteLineItem = components["schemas"]["QuoteLineItem"];
export type QuoteAdjustment = components["schemas"]["QuoteAdjustment"];
export type QuoteLevelAdjustment = components["schemas"]["QuoteLevelAdjustment"];
export type QuoteRequest = components["schemas"]["QuoteRequest"];
/**
 * What this deployment sells into and through, and what it may price in (#291, ADR-0074).
 *
 * A **Region** selects one of the Store's enabled currencies and is what a price is asked for
 * by; a **Channel** is a route to market, decided by the API key a request presents rather than
 * by anything a storefront sends. Neither is a tenant boundary and neither ever will be
 * (ADR-0005).
 *
 * **The `…Identity` pair is how each is named everywhere else** (#292) — on a Price, and on a
 * resolved price — carrying what a reader recognises and leaving the Merchant's `metadata`
 * behind, exactly as {@link VariantIdentity} does for the Variant.
 */
export type Region = components["schemas"]["Region"];
export type RegionIdentity = components["schemas"]["RegionIdentity"];
export type RegionList = components["schemas"]["RegionList"];
export type Channel = components["schemas"]["Channel"];
export type ChannelIdentity = components["schemas"]["ChannelIdentity"];
export type ChannelList = components["schemas"]["ChannelList"];
export type EnabledCurrency = components["schemas"]["EnabledCurrency"];
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
export type CollectionRefusal = components["schemas"]["CollectionRefusal"];
export type RegionRefusal = components["schemas"]["RegionRefusal"];
export type ChannelRefusal = components["schemas"]["ChannelRefusal"];
/**
 * Why minting an API key was refused (#291).
 *
 * Its own family rather than {@link ApiKeyRefusal}'s or {@link ApiKeyNotFound}'s, and the three
 * mean three different things: this is a *Merchant* being turned back at
 * `POST /admin/api-keys`, `ApiKeyRefusal` is the store gate rejecting a credential a storefront
 * presented, and `ApiKeyNotFound` is a Merchant addressing a key that does not exist.
 */
export type MintApiKeyRefusal = components["schemas"]["MintApiKeyRefusal"];
export type StoreCatalogRefusal = components["schemas"]["StoreCatalogRefusal"];
export type CartRefusal = components["schemas"]["CartRefusal"];
export type CartReservations = components["schemas"]["CartReservations"];
export type HeldClaim = components["schemas"]["HeldClaim"];
export type CartReservationRefusal = components["schemas"]["CartReservationRefusal"];
export type OrderRefusal = components["schemas"]["OrderRefusal"];
export type QuoteRequestRefusal = components["schemas"]["QuoteRequestRefusal"];
export type PlaceOrderRequestRefusal = components["schemas"]["PlaceOrderRequestRefusal"];
export type ApiKeyNotFound = components["schemas"]["ApiKeyNotFound"];
/**
 * The one refusal the open byte route makes.
 *
 * A single literal rather than a family, because nothing else about Media is refused: a key
 * that was never stored, an object that has gone, and a deployment whose storage serves its own
 * bytes rather than kobai's all answer this, and a client can act on none of the distinctions.
 */
export type MediaNotFound = components["schemas"]["MediaNotFound"];
/**
 * Every way uploading Media can be refused — and two of its words are about the deployment
 * rather than about kobai.
 *
 * `media-too-large` and `content-type-not-accepted` are judged against `media.maxBytes` and
 * `media.accept` in the Store's own `kobai.config.ts`, so what one Store refuses another takes.
 * A client branching on either should show the `error` beside its own message rather than
 * naming a limit it cannot know: the refusal carries the numbers it was judged against, and
 * `GET /admin/openapi.json` carries them too.
 */
export type MediaUploadRefusal = components["schemas"]["MediaUploadRefusal"];
export type SessionRefusal = components["schemas"]["SessionRefusal"];
export type ApiKeyRefusal = components["schemas"]["ApiKeyRefusal"];
export type PermissionDenied = components["schemas"]["PermissionDenied"];
export type SecretKeyRequired = components["schemas"]["SecretKeyRequired"];
// The last three are the ones that cannot be narrowed exhaustively, and each says so itself
// because a consumer meets the name rather than this comment. The shared argument, once:
// resolving a price, quoting a Cart and placing an Order all run a Workflow, and a Step a
// Project or a Plugin supplied is Extension Point 2 (ADR-0003) — it may refuse with a word Core
// has never heard of, which Core answers 422 because it cannot say what the word means. Closing
// any of the three here would close that Extension Point, so ADR-0060 leaves `reason` a bare
// `string` for exactly these and closes every other family above.

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
 * Why a Cart could not be quoted, with the account of the Workflow run beside it.
 *
 * **`reason` is an open string**, for {@link PlaceOrderRefusal}'s reason and to a slightly
 * sharper degree: the Steps a quote runs are exactly the pricing ones, which are the ones a
 * Project is most likely to have replaced. Core's own are listed in the field's own description
 * — everything the Cart read and `resolve-price` can say, and nothing about payment or stock,
 * because a quote asks for neither.
 */
export type QuoteRefusal = components["schemas"]["QuoteRefusal"];

/**
 * The generated surface itself, for anything the helpers above do not reach.
 *
 * `operations` is deliberately not among them: `openapi-typescript` keys it by
 * `operationId`, kobai's routes declare none, and re-exporting the empty record it produces
 * would be a name that resolves to nothing.
 */
export type { components, paths } from "./schema.ts";
