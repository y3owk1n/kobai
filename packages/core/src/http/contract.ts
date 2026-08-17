import { z } from "@hono/zod-openapi";
import { API_KEY_KINDS, type ApiKeyRejection } from "../auth/api-key.ts";
import type { SessionRejection } from "../auth/session.ts";

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

/** Who the caller is and what they may do — the Admin's first call after a page load. */
export const Session = z
  .object({
    expiresAt: z.iso.datetime(),
    merchant: MerchantIdentity,
    role: RoleSummary,
  })
  .openapi("Session");

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

export const Variant = z
  .object({
    id: z.uuid(),
    sku: z.string(),
    metadata: Metadata,
    prices: z.array(Price).readonly().meta({
      description:
        "Every Price set on this Variant. A Price is a row, so there may be several.",
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

/**
 * There is deliberately no schema for an unrouted path's 404.
 *
 * kobai answers one with `{ error, reason: "not-found" }` so a caller can parse every answer
 * the same way, and that is a not-found handler rather than a route. A description
 * enumerates the paths that exist; a schema named here and referenced by no route would be
 * registered nowhere and describe nothing, which is worse than its absence. See
 * `http/app.ts` and ADR-0040.
 */
