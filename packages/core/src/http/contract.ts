import { z } from "@hono/zod-openapi";
import { API_KEY_KINDS, type ApiKeyRejection } from "../auth/api-key.ts";
import type { SessionPolicy, SessionRejection } from "../auth/session.ts";

/**
 * Every shape kobai's HTTP surface accepts or answers with, as one set of schemas.
 *
 * These are not documentation *about* the routes — they are the objects the routes are
 * declared with, so they are what the surface actually does. A response schema here is
 * checked by the compiler against what its handler returns (`app.openapi` types
 * `c.json(body, status)` against the declaration), and a request schema is checked by
 * Zod against what a caller sent, before the handler runs. The OpenAPI description and
 * the generated client are then produced from these same objects, which is what makes
 * "the description cannot drift from the behaviour" a mechanical fact rather than a
 * promise somebody has to keep.
 *
 * `.openapi("Name")` puts a schema in `components/schemas` and makes every use of it a
 * `$ref`. That is worth doing for anything a Developer will recognise as a *thing* —
 * a Product, a Price, a Session — because it is also the name the generated client gives
 * the type.
 *
 * **Where validation lives.** A schema here is structural: names, types, presence, and
 * the closed sets (`kind`) the database itself enforces. Everything that is a *rule* —
 * whether an address looks like one, whether a password is long enough, whether a SKU is
 * already taken, whether this Store prices in that currency — stays in the module that
 * owns the rule, and answers with its own `reason`. The split is deliberate: a rule that
 * moved into a schema would be a rule a client could be told about but Core could no
 * longer change without a new API version.
 */

/**
 * ADR-0004's escape hatch, in the description: an unindexed, untyped JSON object.
 *
 * Deliberately shapeless. A shape here would be a promise, and a Plugin that needs a
 * promise needs its own table.
 */
export const Metadata = z.record(z.string(), z.unknown()).meta({
  description: "Unindexed, untyped JSON owned by the Merchant and the Project.",
});

// ---- Refusals ------------------------------------------------------------------------

/**
 * The shape every kobai refusal takes: prose for a person, `reason` for a program.
 *
 * One shape whether the caller was turned back at the door or by the handler, so a client
 * parses refusals one way. `reason` is the field to branch on; `error` is the field to
 * show.
 */
export const Refusal = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.string().meta({ description: "Machine-readable. Branch on this." }),
  })
  .openapi("Refusal");

/**
 * The reasons each gate's 401 can carry, keyed by the rejection the gate answers with.
 *
 * The mapped `satisfies` is what makes each of these the *complete and exact* set rather than
 * a remembered one: a fifth way for a session to be rejected has no key here and does not
 * compile, and a key spelled `session-gone` for the rejection `expired` does not either. That
 * is the same guarantee `openapi.test.ts` gives one level up — that a refusal a route declares
 * is one its gate can make — applied to the reasons *inside* a refusal, which is where a
 * client actually branches.
 *
 * They are prefixed rather than shared because the two gates are two (ADR-0020): `missing` at
 * `/admin` and `missing` at `/store` have different fixes, and a client that branched on the
 * bare word would be told the same thing about two different credentials.
 */
const SESSION_REASONS = {
  missing: "session-missing",
  malformed: "session-malformed",
  unknown: "session-unknown",
  expired: "session-expired",
} as const satisfies { [Reason in SessionRejection]: `session-${Reason}` };

const API_KEY_REASONS = {
  missing: "api-key-missing",
  malformed: "api-key-malformed",
  unknown: "api-key-unknown",
  revoked: "api-key-revoked",
} as const satisfies { [Reason in ApiKeyRejection]: `api-key-${Reason}` };

/** A 401 from the admin gate. The four reasons have four different fixes. */
export const SessionRefusal = z
  .object({ error: z.string(), reason: z.enum(SESSION_REASONS) })
  .openapi("SessionRefusal");

/** A 401 from the store gate — a *different* gate, and so a different set of reasons. */
export const ApiKeyRefusal = z
  .object({ error: z.string(), reason: z.enum(API_KEY_REASONS) })
  .openapi("ApiKeyRefusal");

/**
 * A 403. `required` names the one permission the caller's Role does not hold, so an Admin
 * can say *which* rather than "you may not".
 */
export const PermissionDenied = z
  .object({
    error: z.string(),
    reason: z.literal("permission-denied"),
    required: z.string().meta({ description: "The permission the Role does not hold." }),
  })
  .openapi("PermissionDenied");

/**
 * A 403 from the store surface's second gate — the credential is live and insufficient.
 *
 * Its own schema rather than {@link PermissionDenied}, because the two 403s are two things: a
 * Merchant's Role being too narrow names the permission it lacks, and this one names nothing —
 * what a caller has to do about it is mint the other kind of key, which no field could carry
 * (ADR-0055).
 */
export const SecretKeyRequired = z
  .object({ error: z.string(), reason: z.literal("secret-key-required") })
  .openapi("SecretKeyRequired");

/**
 * The header both gates send with a 401 — RFC 6750's challenge.
 *
 * Named here rather than described in prose on each response, so a client can act on it.
 */
export const BearerChallenge = z.object({
  "www-authenticate": z
    .literal("Bearer")
    .meta({ description: "The scheme the request failed to satisfy." }),
});

/**
 * A sign-in that was not accepted.
 *
 * One reason, deliberately: an unknown address and a wrong password are answered
 * identically, and in the same time. Distinguishing them would turn the endpoint into a way
 * to ask who works here.
 */
export const InvalidCredentials = z
  .object({ error: z.string(), reason: z.literal("invalid-credentials") })
  .openapi("InvalidCredentials");

/** A 500. Deliberately says nothing: a stack trace is not the caller's business. */
export const ServerError = z.object({ error: z.string() }).openapi("ServerError");

// ---- Health --------------------------------------------------------------------------

export const AppliedMigrationSet = z
  .object({
    name: z.string(),
    migrationsTable: z.string(),
    migrationsSchema: z.string(),
    applied: z.int().meta({ description: "Rows in this set's tracking table." }),
  })
  .openapi("AppliedMigrationSet");

export const MigrationState = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("pending") }),
    z.object({ status: z.literal("running") }),
    z.object({
      status: z.literal("applied"),
      sets: z.array(AppliedMigrationSet).readonly(),
    }),
    z.object({
      status: z.literal("failed"),
      set: z.string().nullable(),
      message: z.string(),
    }),
  ])
  .openapi("MigrationState");

/** Shaped so a container probe can act on `status` alone. */
export const Health = z
  .object({
    status: z.enum(["ok", "booting", "error"]),
    migrations: MigrationState,
  })
  .openapi("Health");

/**
 * What every route but `/health` answers while migrations have not applied.
 *
 * It carries the whole of `/health` alongside the refusal, so a caller that gets one
 * needs no second request to find out why.
 */
export const Unavailable = z
  .object({
    error: z.string(),
    status: z.enum(["booting", "error"]),
    migrations: MigrationState,
  })
  .openapi("Unavailable");

// ---- Merchants, Roles and Sessions ----------------------------------------------------

export const MerchantIdentity = z
  .object({ id: z.uuid(), email: z.string() })
  .openapi("MerchantIdentity");

export const RoleSummary = z
  .object({
    name: z.string(),
    permissions: z.array(z.string()).readonly().meta({
      description:
        "What this Role may do. A deployment may hold a permission this build of Core has never heard of.",
    }),
  })
  .openapi("RoleSummary");

export const Merchant = MerchantIdentity.extend({ role: RoleSummary }).openapi(
  "Merchant",
);

/**
 * Who the caller is and what they may do — the Admin's first call after a page load.
 *
 * `expiresAt` is described rather than left to be inferred, because it is the one field here
 * whose meaning changed under it: it is not a lifetime fixed at sign-in but the end of an idle
 * window, so a client that cached it once would be reading a deadline that has since moved.
 * The two numbers in that description are read off the policy that decides them rather than
 * retyped, so moving a window moves what the API says about it — and the description a client
 * is generated from cannot go stale about the behaviour it is documenting (ADR-0045).
 *
 * **It is a function of the policy because the window is a Project's** (ADR-0050). This is the
 * one schema on the surface whose *text* depends on how a deployment was configured, so it is
 * built per instance from the numbers that instance actually enforces, and a description
 * generated from a running kobai describes that kobai. A module-level constant would have gone
 * on saying thirty minutes to every deployment that set something else, which is worse than
 * the hardcoded window it replaced: a wrong number is worse than an unconfigurable one.
 */
export function sessionSchema(policy: SessionPolicy) {
  return z
    .object({
      expiresAt: z.iso.datetime().meta({
        description: `When this session ends if no further request is made. Every authenticated request pushes it out by another ${humanDuration(policy.idleWindowMs)} of idleness, so read it from the most recent response rather than caching the one sign-in returned. It is never later than ${humanDuration(policy.absoluteLifetimeMs)} after sign-in, however active the session is; past that the Merchant signs in again.`,
      }),
      merchant: MerchantIdentity,
      role: RoleSummary,
    })
    .openapi("Session");
}

/** What {@link sessionSchema} builds, for the routes that declare it. */
export type SessionSchema = ReturnType<typeof sessionSchema>;

/**
 * A span of milliseconds as a Developer would say it: `30 minutes`, `12 hours`,
 * `2 hours 30 minutes`.
 *
 * The unit lives here rather than in the sentence because the *number* is a Project's now. A
 * template that said "`${ms / 60_000}` minutes" was right for every window Core happened to
 * ship and wrong for the first one that did not divide — a two-minute-five-second window
 * published "2.0833333333333335 minutes" into `openapi.json` and into every generated client
 * from it. This is exact for any whole number of milliseconds and reads the same as the
 * hand-written text did for the two that ship.
 */
function humanDuration(milliseconds: number): string {
  const units = [
    { name: "hour", size: 3_600_000 },
    { name: "minute", size: 60_000 },
    { name: "second", size: 1_000 },
  ] as const;

  const parts: string[] = [];
  let left = milliseconds;
  for (const { name, size } of units) {
    // The last unit takes the remainder rather than a whole count, so nothing is dropped: a
    // window that is not a whole number of seconds says so instead of being rounded silently.
    const count = name === "second" ? left / size : Math.floor(left / size);
    left -= count * size;
    if (count > 0) parts.push(`${count} ${name}${count === 1 ? "" : "s"}`);
  }

  return parts.length > 0 ? parts.join(" ") : "0 seconds";
}

/**
 * The header a sign-in answers with, and the reason there is no `IssuedSession` schema.
 *
 * There used to be one: `Session` plus the `token` to present on every later request. The
 * token now leaves in this header instead and appears in no body at all (ADR-0032), which
 * left `IssuedSession` identical to `Session` — so it is gone, and signing in answers with
 * the same shape as asking who you are.
 */
export const SessionCookieSet = setCookie(
  "`kobai_session`, httpOnly, SameSite=Strict, and Secure whenever the request arrived over HTTPS. It names no Path, so a browser scopes it to the admin surface this request reached — `/admin`, or `/api/admin` for a Project that mounted kobai at `/api`. A browser sends it back by itself; nothing else has to.",
);

/** The header a sign-out answers with: the same cookie, emptied and expired. */
export const SessionCookieCleared = setCookie(
  "`kobai_session`, emptied and expired, so the browser drops it.",
);

/** A `Set-Cookie` a route promises to send. Two routes do, and they say different things. */
function setCookie(description: string) {
  return z.object({ "set-cookie": z.string().meta({ description }) });
}

export const CreateMerchantRequest = z
  .object({
    email: z.string(),
    password: z.string(),
    role: z
      .string()
      .optional()
      .meta({ description: "A Role by name. Defaults to `owner`." }),
  })
  .openapi("CreateMerchantRequest");

export const SignInRequest = z
  .object({ email: z.string(), password: z.string() })
  .openapi("SignInRequest");

/**
 * The one path parameter this API has, and it is a plain string on purpose.
 *
 * Declaring it as a uuid would make `/admin/products/not-an-id` a 400, and it is a 404:
 * an identifier nothing carries and a string that could never be one are the same answer
 * to the caller, and the narrower schema would turn one of them into a different one.
 */
export const IdParam = z.object({
  id: z
    .string()
    .meta({ description: "An identifier. Anything that is not one is not found." }),
});

// ---- API keys -------------------------------------------------------------------------

export const ApiKeyKind = z.enum(API_KEY_KINDS).openapi("ApiKeyKind");

/**
 * What both views of a key agree on, and the reason they are declared together: the fields
 * that identify a key never depend on whether its value is being shown.
 *
 * Not `.openapi()`-named itself — a `$ref` for it would be a name for something a Developer
 * never receives on its own. The two schemas below are what the API answers with.
 */
const ApiKeyIdentity = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: ApiKeyKind,
  createdAt: z.iso.datetime(),
});

/**
 * A key, as it is reported once and never again.
 *
 * Which kind it is can be read off `key` itself — `kobai_pk_…` is publishable and
 * `kobai_sk_…` is secret — so shipping a secret to a browser is a mistake that is visible
 * in a code review, a log line and a bug report, with no lookup.
 */
export const IssuedApiKey = ApiKeyIdentity.extend({
  key: z.string().meta({
    description: "The value itself. Shown at creation and unrecoverable afterwards.",
  }),
}).openapi("IssuedApiKey");

/**
 * A key as the Admin lists it: enough to recognise and revoke, never enough to present.
 *
 * No fragment of the value appears here — not a prefix, not the last four characters. Only
 * a SHA-256 of the whole key is stored, so there is nothing to show, and showing part of one
 * would be a second place a credential partly lives. `name` is what tells two keys apart,
 * which is why minting demands one.
 */
export const ApiKeySummary = ApiKeyIdentity.extend({
  revokedAt: z.iso.datetime().nullable().meta({
    description: "When it stopped working, or `null` while it still does.",
  }),
}).openapi("ApiKeySummary");

/** The list, in an envelope — the same shape, and the same reason, as `ProductList`. */
export const ApiKeyList = z
  .object({ apiKeys: z.array(ApiKeySummary).readonly() })
  .openapi("ApiKeyList");

export const CreateApiKeyRequest = z
  .object({
    name: z.string().meta({
      description: "How a Merchant tells one key from another when revoking.",
    }),
    kind: ApiKeyKind,
  })
  .openapi("CreateApiKeyRequest");

// ---- The Store ------------------------------------------------------------------------

/** No identifier, because there is only one (ADR-0005). */
export const Store = z
  .object({
    name: z.string(),
    defaultCurrency: z.string().meta({ description: "ISO 4217, upper case." }),
    metadata: Metadata,
  })
  .openapi("Store");

// ---- Catalog --------------------------------------------------------------------------

export const Price = z
  .object({
    id: z.uuid(),
    amount: z.int().meta({
      description: "Minor units of `currency` — 1250 is USD 12.50.",
    }),
    currency: z.string(),
    metadata: Metadata,
  })
  .openapi("Price");

/**
 * What the Store has of a Variant, and what is left to sell (ADR-0018).
 *
 * `available` is `onHand - reserved`, worked out on every read rather than stored — a third
 * number that could disagree with the other two would disagree invisibly, and the first
 * sign of it would be the Store overselling.
 */
export const Inventory = z
  .object({
    variantId: z.uuid(),
    onHand: z.int().meta({ description: "What the Store physically has." }),
    reserved: z.int().meta({
      description: "How much of it is claimed by Reservations still being placed.",
    }),
    available: z
      .int()
      .meta({ description: "`onHand - reserved` — what is left to sell." }),
  })
  .openapi("Inventory");

/** Setting stock is a statement of what the Store has, not an adjustment to it. */
export const SetInventoryRequest = z
  .object({
    onHand: z.int().min(0).meta({
      description:
        "What the Store has, counted. Replaces whatever was there; it is not added to it.",
    }),
  })
  .openapi("SetInventoryRequest");

export const Variant = z
  .object({
    id: z.uuid(),
    sku: z.string(),
    metadata: Metadata,
    prices: z.array(Price).readonly().meta({
      description:
        "Every Price set on this Variant. A Price is a row, so there may be several.",
    }),
    inventory: Inventory.nullable().meta({
      description:
        "What the Store has of this Variant, or `null` when nobody is counting it. Untracked is not the same as none left: an untracked Variant sells freely.",
    }),
  })
  .openapi("Variant");

/** As a list reports it: no Variants, because a list is not a detail view. */
export const Product = z
  .object({ id: z.uuid(), title: z.string(), metadata: Metadata })
  .openapi("Product");

export const ProductDetail = Product.extend({
  variants: z.array(Variant).readonly(),
}).openapi("ProductDetail");

/**
 * The list, in an envelope.
 *
 * Unpaginated today. The envelope is why pagination can arrive beside the list rather
 * than by breaking this response.
 */
export const ProductList = z
  .object({ products: z.array(Product).readonly() })
  .openapi("ProductList");

export const CreateVariantRequest = z
  .object({ sku: z.string(), metadata: Metadata.optional() })
  .openapi("CreateVariantRequest");

/**
 * A Product and the Variants that make it sellable, created together.
 *
 * `variants` is required and non-empty because a Product is never sellable in itself
 * (ADR-0008) — a Product with no options is not the exception, it is the ordinary case,
 * and it gets exactly one Variant like everything else.
 */
export const CreateProductRequest = z
  .object({
    title: z.string(),
    metadata: Metadata.optional(),
    variants: z.array(CreateVariantRequest).min(1),
  })
  .openapi("CreateProductRequest");

/** Setting a Price is an insert, never an update: calling this twice leaves two Prices. */
export const SetPriceRequest = z
  .object({
    amount: z.int().meta({
      description: "Minor units — 1250 for USD 12.50. Whole, and not negative.",
    }),
    currency: z
      .string()
      .optional()
      .meta({ description: "ISO 4217. Defaults to the Store's default currency." }),
    metadata: Metadata.optional(),
  })
  .openapi("SetPriceRequest");

// ---- Price resolution -----------------------------------------------------------------

/** One Step of a Workflow run: the slot it filled, and what filled it. */
export const StepReport = z
  .object({
    step: z.string().meta({ description: "The slot the Workflow declares." }),
    implementation: z.string().meta({
      description: "The Step that filled it. Differs when a Project replaced it.",
    }),
  })
  .openapi("StepReport");

export const VariantIdentity = z
  .object({ id: z.uuid(), sku: z.string() })
  .openapi("VariantIdentity");

/**
 * A resolved price, and which Steps produced it.
 *
 * `workflow.steps` is part of the contract rather than a debugging nicety: it is what
 * lets a Developer who replaced a Step *see* that theirs ran (spec story 33).
 */
export const ResolvedPrice = z
  .object({
    variant: VariantIdentity,
    price: z.object({ id: z.uuid(), amount: z.int(), currency: z.string() }),
    workflow: z.object({
      name: z.string(),
      steps: z.array(StepReport).readonly(),
    }),
  })
  .openapi("ResolvedPrice");

/**
 * A Workflow declining to resolve a price, and how far it got.
 *
 * `reason` is Core's own when Core's own Steps refused, and whatever a Project's or a
 * Plugin's Step said when one of those did — which is why it is a string and not a closed
 * set. Core answers 422 for a reason it does not know: the request was well formed and the
 * Workflow declined it, which is the most that can honestly be said.
 */
export const PriceRefusal = z
  .object({
    error: z.string(),
    reason: z.string(),
    workflow: z.object({
      name: z.string(),
      failed: z.string().meta({ description: "The slot that refused." }),
      steps: z.array(StepReport).readonly(),
    }),
  })
  .openapi("PriceRefusal");

// ---- Carts ----------------------------------------------------------------------------

/**
 * Who a storefront has said this Cart is for — a *reference*, never a credential.
 *
 * ADR-0020 has Core store an email with an optional external identity and trust the identity a
 * storefront asserts over a secret key. There is no password here and no Shopper table behind
 * it, and `null` on the Cart is a guest, which is the ordinary path.
 */
export const CartShopper = z
  .object({
    email: z
      .string()
      .meta({ description: "The reference's key, as the storefront wrote it." }),
    externalId: z.string().nullable().meta({
      description:
        "This Shopper in whatever system the storefront authenticates against.",
    }),
  })
  .openapi("CartShopper");

/**
 * One line of a Cart: a Variant, and how many of it.
 *
 * It carries no price and no snapshot, which is the asymmetry ADR-0009 asks for — an Order's
 * Line Items snapshot title, SKU and price as at capture so that history cannot be rewritten,
 * and a Cart's are the opposite kind of row.
 */
export const CartLineItem = z
  .object({
    id: z.uuid(),
    variant: VariantIdentity,
    quantity: z.int(),
    metadata: Metadata,
  })
  .openapi("CartLineItem");

/**
 * A Cart, and what every route on it answers with — creating one, changing it, or reading it.
 *
 * **No totals.** ADR-0009 makes a Cart unauthoritative: what a Shopper pays is resolved at
 * Capture, and a figure here would be one nothing stands behind and the first thing anybody
 * would mistake for one.
 */
export const Cart = z
  .object({
    id: z.uuid().meta({
      description:
        "The identifier, and the whole of the authority to act on this Cart — there is no Shopper session to hang one off (ADR-0020). Treat it as a credential: it is unguessable, and anyone holding it can change this Cart.",
    }),
    shopper: CartShopper.nullable().meta({
      description: "`null` for a guest, which is the ordinary path.",
    }),
    lineItems: z.array(CartLineItem).readonly(),
    metadata: Metadata,
    expiresAt: z.iso.datetime().meta({
      description:
        "When this Cart stops being placeable. A lifetime fixed at creation, not an idle window — changing a Cart does not push it out.",
    }),
    expired: z.boolean().meta({
      description:
        "Whether that moment has passed, as the server judges it. Branch on this rather than comparing `expiresAt` against a browser's clock. An expired Cart still reads and refuses every change.",
    }),
    placed: z.boolean().meta({
      description:
        "Whether this Cart has already become an Order. A Cart becomes exactly one, so this is final: a placed Cart still reads, and refuses every change and every further placement. Distinct from `expired` — an expired Cart ran out of time, and a placed one has already been bought.",
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Cart");

/** Attaching a Shopper, or `null` to make the Cart a guest's again. */
const AttachShopper = z.object({
  email: z.string(),
  externalId: z.string().nullable().optional(),
});

export const CreateCartRequest = z
  .object({
    shopper: AttachShopper.nullable().optional().meta({
      description: "Needs a secret key. A publishable one is refused (ADR-0020).",
    }),
    metadata: Metadata.optional(),
  })
  .openapi("CreateCartRequest");

/** Name what should change; naming neither is refused rather than treated as a no-op. */
export const UpdateCartRequest = z
  .object({
    shopper: AttachShopper.nullable().optional().meta({
      description:
        "Needs a secret key. `null` detaches the Shopper; absent leaves whoever is on the Cart alone.",
    }),
    metadata: Metadata.optional(),
  })
  .openapi("UpdateCartRequest");

export const AddCartLineItemRequest = z
  .object({
    variantId: z.string(),
    quantity: z.int().optional().meta({ description: "At least 1. Defaults to 1." }),
    metadata: Metadata.optional(),
  })
  .openapi("AddCartLineItemRequest");

export const UpdateCartLineItemRequest = z
  .object({
    quantity: z.int().optional().meta({
      description: "At least 1. Removing a line is `DELETE`, not a quantity of zero.",
    }),
    metadata: Metadata.optional(),
  })
  .openapi("UpdateCartLineItemRequest");

/** The Cart, and the Line Item on it — a plain string each, for {@link IdParam}'s reason. */
export const CartLineItemParams = IdParam.extend({
  lineItemId: z
    .string()
    .meta({ description: "A Line Item of this Cart. Anything else is not found." }),
});

/**
 * A Cart operation refused, in the shape every other kobai refusal uses.
 *
 * `reason` is a closed set here, unlike `PriceRefusal`'s: nothing a Project or a Plugin
 * supplies runs on this path, so every refusal it can make is Core's own and a client can
 * narrow on the lot. Each route declares only the ones it can actually make.
 */
export const CartRefusal = z
  .object({
    error: z.string(),
    reason: z.enum([
      "invalid",
      "secret-key-required",
      "cart-not-found",
      "cart-expired",
      "cart-placed",
      "line-item-not-found",
      "variant-not-found",
      "variant-not-priced",
    ]),
  })
  .openapi("CartRefusal");

// ---- Orders ----------------------------------------------------------------------------

/**
 * An **Adjustment** — a discount or a surcharge, held as its own line (ADR-0022).
 *
 * A line rather than a number folded into an amount, which is the whole of what the shape
 * promises: a `unitAmount` beside one still says what a Variant cost, and every figure derived
 * from the Order — the tax base, a refund, revenue — is derived from what was actually charged.
 *
 * `code` is deliberately an open string. Core defines no Adjustment of its own and validates
 * none, because an Adjustment kobai understood would be a discount engine and that is not what
 * ADR-0022 asked for — the Step that added it is what names it.
 */
export const OrderAdjustment = z
  .object({
    id: z.uuid(),
    code: z.string().meta({
      description:
        "Machine-readable, and chosen by the Step that added it — `lead-time-surcharge`, `loyalty-discount`. Core defines none of its own, so this is not a closed set.",
    }),
    description: z.string().meta({ description: "For a person to read." }),
    amount: z.int().meta({
      description:
        "**Signed** minor units: negative discounts, positive surcharges. The total accounts for it either way.",
    }),
    metadata: Metadata,
  })
  .openapi("OrderAdjustment");

/**
 * One line of an Order — a **snapshot**, and the reason it looks nothing like a Cart's.
 *
 * `title`, `sku` and `unitAmount` were copied at Capture, so renaming a Product or repricing a
 * Variant does not reach them and deleting one does not destroy this line (ADR-0009).
 * `variantId` is here for navigation and is `null` once the Variant is gone — never for
 * display, and never for arithmetic.
 */
export const OrderLineItem = z
  .object({
    id: z.uuid(),
    variantId: z.uuid().nullable().meta({
      description:
        "The Variant this line was for, for navigation only. `null` once it has been deleted — everything a person reads is beside it.",
    }),
    title: z.string().meta({ description: "The Product's title as at Capture." }),
    sku: z.string().meta({ description: "The Variant's SKU as at Capture." }),
    unitAmount: z.int().meta({
      description: "What one of it cost, in minor units — 1250 is USD 12.50.",
    }),
    quantity: z.int(),
    tax: z.int().meta({
      description:
        "Tax on this line, in minor units. Zero until a tax Step is wired; present so that adding tax later is not a change to what an Order means.",
    }),
    adjustments: z.array(OrderAdjustment).readonly().meta({
      description:
        "The discounts and surcharges on this line, in the order they were applied. `unitAmount` above is untouched by them; `total` below accounts for all of them.",
    }),
    total: z.int().meta({
      description:
        "What this line came to: `unitAmount` × `quantity`, plus its Adjustments, plus `tax`.",
    }),
    metadata: Metadata,
  })
  .openapi("OrderLineItem");

/**
 * The **Payment** taken for an Order — the record that money moved (ADR-0053).
 *
 * kobai defines the Payment Provider interface and ships no implementation of it, so `provider`
 * names whatever the deployment was wired with and `reference` is that system's own handle on the
 * payment. kobai stores both and parses neither: quote the reference at the provider, not here.
 */
export const Payment = z
  .object({
    id: z.uuid(),
    provider: z.string().meta({
      description:
        "What took the money, as the deployment named it — `manual`, `stripe`. An Order placed before the deployment changed provider still says which system holds its money.",
    }),
    reference: z.string().meta({
      description:
        "The provider's own handle on this payment. Opaque to kobai, and what a refund is asked against.",
    }),
    amount: z.int().meta({
      description: "What was taken, in minor units of `currency` — the Order's total.",
    }),
    currency: z.string().meta({ description: "ISO 4217." }),
    received: z.boolean().meta({
      description:
        "Whether the money **arrived**, or was only arranged for. `true` is a card charged or a transfer taken; `false` is a provider that arranges payment out of band — an invoice, a bank transfer, cash at the counter — so the Order is real and nobody has been paid yet. It is what the provider said at Capture and is never updated afterwards: an Order is immutable, and collecting an arranged payment happens outside kobai.",
    }),
    createdAt: z.iso.datetime(),
  })
  .openapi("Payment");

/**
 * An Order as a **list** reports it — everything but what was bought.
 *
 * The split `Product` and `ProductDetail` make, for the same reason: a list is not a detail
 * view. `payment` is here rather than in the detail alone, because whether the money actually
 * arrived is what somebody reading a list of Orders is looking down the column for.
 */
export const OrderSummary = z
  .object({
    id: z.uuid(),
    number: z.int().meta({
      description:
        "The Order number — what a Shopper reads over the phone, and not the identifier. Monotonic and stable forever, and **not gapless**: gapless numbering is an invoicing requirement, and invoicing is not kobai's.",
    }),
    shopper: CartShopper.nullable().meta({
      description: "As at Capture. `null` for a guest, which is the ordinary path.",
    }),
    currency: z.string().meta({ description: "ISO 4217. Every amount here is in it." }),
    total: z.int().meta({
      description:
        "What was charged, in minor units — every Line Item's total, plus the Order's own Adjustments.",
    }),
    payment: Payment.nullable().meta({
      description:
        "The money taken for this Order. Present on every Order this version of kobai placed — payment is taken before Capture and written in the same transaction, so a declined one leaves no Order at all. `null` is what an Order placed before the Payment record existed reads as. Whether that money actually arrived is `payment.received`, which is a different question and the one a Merchant asks.",
    }),
    createdAt: z.iso.datetime().meta({
      description: "The moment of Capture, when this Order became immutable.",
    }),
  })
  .openapi("OrderSummary");

/**
 * An Order — the immutable financial record of a completed purchase.
 *
 * There is no `updatedAt`, deliberately: an Order is never edited (ADR-0009), so a second
 * timestamp would be a field whose only honest value is `createdAt` and the first thing
 * anybody would read as permission to write to the record.
 */
export const Order = OrderSummary.extend({
  lineItems: z.array(OrderLineItem).readonly().meta({
    description:
      "In SKU order, the way a Product reports its Variants — not the order they were added to the Cart. Read a line by its `sku` rather than by position.",
  }),
  adjustments: z.array(OrderAdjustment).readonly().meta({
    description:
      "The Adjustments on the Order as a whole — the ones belonging to no single line, such as a basket-wide voucher. A line's own are on the line.",
  }),
  metadata: Metadata,
}).openapi("Order");

/**
 * The list, in an envelope — the same shape, and the same reason, as `ProductList`.
 *
 * Unpaginated today. The envelope is why pagination can arrive beside the list rather than by
 * breaking this response.
 */
export const OrderList = z
  .object({ orders: z.array(OrderSummary).readonly() })
  .openapi("OrderList");

/**
 * The Order, and the Steps that produced it.
 *
 * `workflow.steps` is part of the contract rather than a debugging nicety, for the same reason
 * it is on a resolved price: it is what lets a Developer who replaced a Step see that theirs
 * ran. It is absent from {@link Order} because which Steps ran is a fact about one request and
 * not about the record — so reading the Order back later answers with the record alone.
 */
export const PlacedOrder = Order.extend({
  workflow: z.object({
    name: z.string(),
    steps: z.array(StepReport).readonly(),
  }),
}).openapi("PlacedOrder");

export const PlaceOrderRequest = z
  .object({
    cartId: z.string().meta({
      description:
        "The Cart to place. Holding its identifier is the whole of the authority to act on it (ADR-0020).",
    }),
  })
  .openapi("PlaceOrderRequest");

/**
 * The key a storefront names so that retrying is safe — Stripe's header, and Stripe's name for
 * it, because kobai already follows Stripe for the publishable/secret split (ADR-0020).
 *
 * A header rather than a field of the body, and that is what makes "the same key with a
 * different body" a question there is an answer to: the body is the request, and the key is what
 * says which attempt at it this is.
 */
export const IdempotencyKeyHeader = z.object({
  "idempotency-key": z.string().min(1).max(255).optional().meta({
    description:
      "A value of your own choosing, unique to this purchase. Send the same one on every retry of the same request and at most one Order is placed; the retry answers 200 with that Order instead of 201. Reusing one for a different body is refused. Optional, and a request without one is not protected against a retry after a timeout.",
  }),
});

/**
 * A Workflow declining to place an Order, and how far it got.
 *
 * `reason` is a string rather than a closed set, exactly as `PriceRefusal`'s is: Core's own
 * Steps refuse with reasons Core knows, and a Project's or a Plugin's Step refuses with
 * whatever it likes — which is the point of being able to put one in this Workflow. Core
 * answers 422 for a reason it does not know: the request was well formed and the Workflow
 * declined it, which is the most that can honestly be said.
 */
export const PlaceOrderRefusal = z
  .object({
    error: z.string(),
    reason: z.string(),
    workflow: z
      .object({
        name: z.string(),
        failed: z.string().meta({ description: "The slot that refused." }),
        steps: z.array(StepReport).readonly(),
      })
      .optional()
      .meta({
        description:
          "How far the Workflow got. Absent when the request was turned back before it ran at all — which is what an idempotency key already used for a different request, or one whose first attempt is still in flight, is refused by. Branch on `reason` rather than on this.",
      }),
  })
  .openapi("PlaceOrderRefusal");

/**
 * Reading an Order that is not there.
 *
 * A closed set of one: nothing a Project or a Plugin supplies runs on this path, so the only
 * refusal a reader can meet past the gates is that there is no such Order.
 */
export const OrderRefusal = z
  .object({ error: z.string(), reason: z.enum(["order-not-found"]) })
  .openapi("OrderRefusal");

/**
 * There is deliberately no schema for an unrouted path's 404.
 *
 * kobai answers one with `{ error, reason: "not-found" }` so a caller can parse every answer
 * the same way, and that is a not-found handler rather than a route. A description
 * enumerates the paths that exist; a schema named here and referenced by no route would be
 * registered nowhere and describe nothing, which is worse than its absence. See
 * `http/app.ts` and ADR-0040.
 */
