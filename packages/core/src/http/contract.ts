import { z } from "@hono/zod-openapi";
import { API_KEY_KINDS, type ApiKeyRejection } from "../auth/api-key.ts";
import type { MerchantCreation } from "../auth/merchant.ts";
import type { SessionPolicy, SessionRejection } from "../auth/session.ts";
import type { CartRefusal as CartRefusalReason } from "../cart/write.ts";
import type {
  PriceDeletion,
  ProductDeletion,
  VariantDeletion,
} from "../catalog/delete.ts";
import type { VariantUpdate } from "../catalog/update.ts";
import type { PriceCreation, ProductCreation } from "../catalog/write.ts";
import { DEFAULT_PAGE_LIMIT, decodeCursor, MAX_PAGE_LIMIT } from "../db/page.ts";
import type { IdempotencyRefusal } from "../order/idempotency.ts";
import type { PlaceOrderRefusal as PlaceOrderReason } from "../order/place-order.ts";
import type { PriceResolutionRefusal } from "../pricing/resolve-price.ts";
import type { InventoryUpdate } from "../reservation/inventory.ts";

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

/**
 * ADR-0013's escape hatch, in the description: the open half of a Workflow's context, sent on
 * the request that runs one.
 *
 * The same shapelessness as {@link Metadata} and a different thing entirely — this is **not
 * stored**. It lives for the length of one request, reaches every Step of the Workflow that
 * request runs, and is gone.
 *
 * **A named component**, unlike `Metadata`, which is inlined wherever it appears. A Developer
 * reading `metadata` on a request body has every reason to expect the column, so the
 * description has to be able to say which of the two this is — and a name is what a generated
 * client shows them. It is deliberately not shared with `Metadata`: they will diverge the day
 * either grows a constraint, and merging them now would make that a breaking change to both.
 *
 * **The whole description lives here**, because a `$ref` to it is what a field carrying it
 * emits: a `.meta()` on such a field does not sit beside the reference, it *overwrites this
 * one* for every other field too. So say it once, and say it generally.
 */
export const OpenMetadata = z
  .record(z.string(), z.unknown())
  .meta({
    description:
      "Optional. The open half of the Workflow this request runs — whatever that deployment's Steps need and Core does not model: a card token for the Payment Provider, a lead time, a customer tier. It reaches every Step verbatim and is **never stored**; an entity's own `metadata` column is a different thing. Core reads no key out of it (ADR-0013). This request's query string reaches the same place and works the same way; send a key in only one of them, because a key in both is refused at 400 rather than resolved in favour of either.",
  })
  .openapi("OpenMetadata");

// ---- Refusals ------------------------------------------------------------------------

/**
 * The shape every kobai refusal takes: prose for a person, `reason` for a program.
 *
 * One shape whether the caller was turned back at the door or by the handler, so a client
 * parses refusals one way. `reason` is the field to branch on; `error` is the field to
 * show — and only the first of those is promised (ADR-0060). The prose may be rewritten in
 * a patch; the word a client branches on may not.
 *
 * **There is no shared `Refusal` schema, and its absence is the decision.** One existed, with
 * `reason` typed `z.string()`, and it was what thirteen of Core's own reasons were declared
 * through — so renaming one compiled, passed every test, and regenerated the description and
 * the client byte for byte identically, while breaking a caller at runtime (ADR-0060). Each
 * family below therefore names the closed set it can actually answer with, built by a mapped
 * `satisfies` over the union the module already declares, exactly as {@link SessionRefusal}'s
 * is. The two schemas that keep an open `reason` — {@link PriceRefusal} and
 * {@link PlaceOrderRefusal} — are the ones a Step of a Project's or a Plugin's own can refuse
 * through, and closing those would close Extension Point 2.
 *
 * One schema per family rather than one per status, following {@link CartRefusal}. A per-status
 * schema *would* compile — `refused` returns one body type across every status its route names,
 * and the compiler still narrows it per status — so this is a choice: every component name is
 * promised surface under ADR-0060, and twenty of them would do four names' work. Which of a
 * family's reasons a given status actually carries stays in that route's own prose, which is
 * where the three differently-worded 404s of `CART_REFUSALS` already live.
 */

/**
 * The two reasons written **above** every handler, and so the two no route's schema is checked
 * against.
 *
 * `invalid` comes from `invalidRequestHook`, for a body that parses and does not fit its
 * schema; `malformed-body` comes from `app.onError`, for one that will not parse at all. Both
 * answer 400 and neither goes through `app.openapi`, so a closed set that omitted one
 * described a narrower surface than the one being served — which `CartRefusal` and
 * `PlaceOrderRequestRefusal` both did until #149. Every family that can be reached with a body
 * spreads these, and `http/refusal-reasons.test.ts` is what holds the next one to it.
 */
const REQUEST_REASONS = {
  invalid: "invalid",
  "malformed-body": "malformed-body",
} as const;

type RequestReason = (typeof REQUEST_REASONS)[keyof typeof REQUEST_REASONS];

/**
 * The `reason` field of a refusal a **Step** can make: an open string, described by the words
 * Core itself uses.
 *
 * The set cannot be closed — a Step of a Project's or a Plugin's own is Extension Point 2 and
 * may refuse with anything, which is the whole point of putting one in a Workflow — and it
 * cannot honestly be half-closed either: `anyOf: [enum, string]` generates as `"a" | string`,
 * which *is* `string` in TypeScript, so a client would gain a schema it could not narrow on.
 *
 * What can be done is what this does. The words Core answers with are listed in the
 * description, **built from the constant rather than retyped**, and that constant is held to
 * the modules' own unions by a mapped `satisfies` — so renaming one of Core's reasons turns
 * the constant red naming it, and a *consistent* rename still moves the description and the
 * generated client, where a review can see it. That is the whole of what ADR-0060 can promise
 * about a `reason` on this half of the surface, and it is deliberately less than the closed
 * sets get.
 */
function stepReason(known: Readonly<Record<string, string>>) {
  return z.string().meta({
    description: `Machine-readable. Branch on this. Core's own are \`${Object.values(known).join("`, `")}\`; a Step this deployment supplied may refuse with anything else, which is answered 422 because Core cannot say what it means.`,
  });
}

/** The `reason`s an operation of Core's can refuse with, read off the operation itself. */
type Refused<Result> = Extract<
  Result,
  { readonly ok: false; readonly reason: string }
>["reason"];

/**
 * A request that could not be used — the one refusal a route with a body always declares.
 *
 * Its own schema rather than a share of a family's, because it is all that the routes with
 * nothing else to refuse — signing in, minting an API key — can answer at 400.
 */
export const InvalidRequest = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.enum(REQUEST_REASONS).meta({
      description:
        "`invalid` if the body does not fit this endpoint's schema; `malformed-body` if it is not JSON at all. Different fixes, so they are different words.",
    }),
  })
  .openapi("InvalidRequest");

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

// ---- Paging --------------------------------------------------------------------------

/**
 * What every list route on this surface takes, and it is the same two parameters everywhere
 * (ADR-0064).
 *
 * A surface where some lists page and others do not is one a client has to learn twice, so
 * this is declared once and named by each list route rather than spelled per route. Both
 * parameters are optional: a caller that sends neither gets the first page at the default
 * size, which is why adding this to a list that returned everything breaks nobody.
 *
 * There is deliberately **no `offset` and no total**. An offset is evaluated against the
 * table as it is when the page is fetched, so an insert between two pages skips or repeats a
 * row without saying so; a total is a second query over the whole table, and it is wrong by
 * the time it is rendered on exactly the tables large enough to want one.
 *
 * **`after` is decoded here rather than in a handler**, so an unusable cursor is answered
 * `invalid` at 400 by the same hook that answers a body that does not fit — and so what a
 * handler receives is a position rather than a string it would have to check again.
 */
export const PageQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT)
    .meta({
      description: `How many to answer with. Between 1 and ${MAX_PAGE_LIMIT}; ${DEFAULT_PAGE_LIMIT} if it is not sent. More than ${MAX_PAGE_LIMIT} is **refused** rather than quietly reduced, because a caller that asked for 5,000 and received ${MAX_PAGE_LIMIT} would read the short page as the end of the list.`,
    }),
  after: z
    .string()
    .transform((raw, ctx) => {
      const cursor = decodeCursor(raw);
      if (cursor === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "not a cursor this API issued",
        });
        return z.NEVER;
      }
      return cursor;
    })
    .optional()
    .meta({
      description:
        "The `nextCursor` of the previous page. **Opaque** — it is not an identifier, not a timestamp, and nothing about what is inside it is promised. Send it back exactly as it was received; omit it for the first page.",
    }),
});

/**
 * The field every list answers beside its items, and the only end-of-list signal there is.
 *
 * **Absent** rather than `null` when there is nothing further, because a client that has to
 * tell "no more" from "not asked" is being told the same thing twice. And absence rather than
 * a short page: a page can be short for other reasons — filtering, once these routes filter —
 * so a caller that stopped on a short page would stop early the day one arrives.
 */
export const NextCursor = z.string().optional().meta({
  description:
    "Pass as `after` to fetch what follows this page. **Absent when there is no further page**, which is the only way to know the list has ended — a short page is not one.",
});

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
 * Every way adding a colleague can be refused, as a closed set.
 *
 * The keys are checked against `createMerchant`'s own union, so a fourth way to refuse a
 * Merchant has no key here and does not compile — the guarantee {@link SessionRefusal} gets
 * from `SessionRejection`, applied to a handler's refusals instead of a gate's.
 */
const MERCHANT_REASONS = {
  ...REQUEST_REASONS,
  "unknown-role": "unknown-role",
  "email-taken": "email-taken",
} as const satisfies { [R in Refused<MerchantCreation> | RequestReason]: R };

export const MerchantRefusal = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.enum(MERCHANT_REASONS).meta({
      description: "Machine-readable. Branch on this.",
    }),
  })
  .openapi("MerchantRefusal");

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
  .object({ apiKeys: z.array(ApiKeySummary).readonly(), nextCursor: NextCursor })
  .openapi("ApiKeyList");

export const CreateApiKeyRequest = z
  .object({
    name: z.string().meta({
      description: "How a Merchant tells one key from another when revoking.",
    }),
    kind: ApiKeyKind,
  })
  .openapi("CreateApiKeyRequest");

/**
 * Revoking a key that is not there — a set of one, and a literal for that reason.
 *
 * There is no `satisfies` here and none is missing: `revokeApiKey` answers a boolean, so this
 * reason is written in the handler, and a literal schema is what binds it — the handler's
 * `reason: "api-key-not-found" as const` is typed against this and a rename on either side
 * fails to build. Checked, on `metadata-in-both`, rather than assumed.
 *
 * Minting one refuses only {@link InvalidRequest}'s two, so this is the whole of what the API
 * key routes add. `api-key-not-found` and not `not-found`: it is a *different* word from the
 * `api-key-*` set the store gate answers 401 with, and it has to stay different, because one
 * is a Merchant addressing a key that does not exist and the other is a storefront presenting
 * a credential.
 */
export const ApiKeyNotFound = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.literal("api-key-not-found").meta({
      description: "Machine-readable. Branch on this.",
    }),
  })
  .openapi("ApiKeyNotFound");

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

/**
 * How a Variant is delivered — the **name** of the Fulfilment Strategy it points at.
 *
 * A string and deliberately not an enum: the set is open (ADR-0014), Core ships `physical` and
 * `digital`, and a Plugin's Strategy is wired by the Project under whatever key it likes. An
 * enumeration here would be the closed set that forces a Core change the first time somebody
 * sells a rental — and would make this description wrong on every deployment that wired one.
 *
 * An object holding one key, so that the next thing a Variant needs to say about how it is
 * fulfilled arrives beside this one rather than by changing its shape.
 */
export const VariantFulfilment = z
  .object({
    strategy: z.string().meta({
      description:
        "The Fulfilment Strategy this Variant is delivered by, by name — `physical`, `digital`, or whatever this deployment wired. What that Strategy answers about shipping, stock and Lead Time is recorded on an Order's Fulfilments, where it is a snapshot rather than a live decision.",
    }),
  })
  .openapi("VariantFulfilment");

export const Variant = z
  .object({
    id: z.uuid(),
    sku: z.string(),
    fulfilment: VariantFulfilment,
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
 * The list, in an envelope — the items, and how to ask for what follows them.
 *
 * The envelope is why paging arrived beside this list rather than by breaking it: a client
 * reading `products` is unaffected by {@link NextCursor} appearing next to it (ADR-0064).
 */
export const ProductList = z
  .object({ products: z.array(Product).readonly(), nextCursor: NextCursor })
  .openapi("ProductList");

export const CreateVariantRequest = z
  .object({
    sku: z.string(),
    fulfilment: VariantFulfilment.optional().meta({
      description:
        "The Fulfilment Strategy this Variant is delivered by. Defaults to `physical`. Naming one this deployment has not wired is refused: a Plugin's Strategy is wired in the Project's `kobai.config.ts`, and installing the Plugin does not do it.",
    }),
    metadata: Metadata.optional(),
  })
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

/**
 * What a Merchant may change on a Variant that already exists — and, by its absence, what they
 * may not (ADR-0062).
 *
 * **Every field is optional and each one absent means "leave it".** That is what makes this a
 * `PATCH` rather than a `PUT`: a full replacement would make a client that omitted `metadata`
 * clear it, which is data loss written as an ordinary request. A body naming none of them is
 * refused rather than answered with the row unchanged, because it is the shape a body naming
 * a field this route does not carry collapses to.
 *
 * **There is no Price here, and that is a decision rather than an omission.** A Price is a row
 * (ADR-0008), so a new one is how a Variant says something new about what it costs and
 * `select-price` resolves the newest — `POST /admin/variants/{id}/prices` supersedes, and
 * `DELETE …/prices/{priceId}` removes the one that was wrong.
 */
export const UpdateVariantRequest = z
  .object({
    sku: z.string().optional().meta({
      description:
        "A new SKU for this Variant. Free to change: an Order's Line Items snapshot the SKU they were bought under (ADR-0009), and a Reservation names its subject by identifier rather than by SKU. One another Variant already carries is refused.",
    }),
    fulfilment: VariantFulfilment.optional().meta({
      description:
        "The Fulfilment Strategy this Variant is delivered by, replacing the one it points at — how a poster becomes a download. Naming one this deployment has not wired is refused. Whatever stock has been counted for this Variant stays counted either way: the Strategy answers whether selling one takes something off a shelf, and the count only ever said how many.",
    }),
    metadata: Metadata.optional().meta({
      description: "Replaces what is stored rather than merging into it.",
    }),
  })
  .openapi("UpdateVariantRequest");

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

/** The Variant, and a Price of it — a plain string each, for {@link IdParam}'s reason. */
export const VariantPriceParams = IdParam.extend({
  priceId: z
    .string()
    .meta({ description: "A Price of this Variant. Anything else is not found." }),
});

/**
 * Every way a catalog operation can be refused, as a closed set — {@link CartRefusal}'s shape
 * on the other surface.
 *
 * **One set across nine routes**, because that is what the handlers can be held to: `refused`
 * returns one body type across every status its route declares, so the schema at a route's 404
 * and the schema at its 409 have to be the same one. Which of these a given route can actually
 * answer is in that route's own prose, where the distinction between three different 404s
 * already lives.
 *
 * The keys are checked against the unions the catalog modules already declare — the seven
 * operations below, whose reasons overlap heavily — so a rename in `catalog/write.ts`,
 * `catalog/update.ts` or `catalog/delete.ts` turns *this* red naming the reason, rather than
 * regenerating a description that quietly says something else. **Correcting a Variant added no
 * key at all**: every way it refuses is a word creation already answers with, so a client that
 * branches on this set needed no new arm the day that route shipped (ADR-0062). `last-variant` and `stock-is-reserved` are the
 * two ADR-0059 recorded as promised in prose and nowhere else; they are here now.
 */
const CATALOG_REASONS = {
  ...REQUEST_REASONS,
  "product-not-found": "product-not-found",
  "variant-not-found": "variant-not-found",
  "price-not-found": "price-not-found",
  "sku-taken": "sku-taken",
  "last-variant": "last-variant",
  "stock-is-reserved": "stock-is-reserved",
  "unsupported-currency": "unsupported-currency",
  "unknown-fulfilment-strategy": "unknown-fulfilment-strategy",
} as const satisfies {
  [R in
    | Refused<ProductCreation>
    | Refused<ProductDeletion>
    | Refused<VariantDeletion>
    | Refused<VariantUpdate>
    | Refused<PriceCreation>
    | Refused<PriceDeletion>
    | Refused<InventoryUpdate>
    | RequestReason]: R;
};

export const CatalogRefusal = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.enum(CATALOG_REASONS).meta({
      description: "Machine-readable. Branch on this.",
    }),
  })
  .openapi("CatalogRefusal");

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
const PRICE_RESOLUTION_REASONS = {
  "variant-not-found": "variant-not-found",
  "price-not-set": "price-not-set",
} as const satisfies { [R in PriceResolutionRefusal]: R };

export const PriceRefusal = z
  .object({
    error: z.string(),
    reason: stepReason(PRICE_RESOLUTION_REASONS),
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
 *
 * The keys are checked against `cart/write.ts`'s own union rather than restated, which is what
 * the list here used to be — and `malformed-body` is here because a Cart route takes a JSON
 * body and `app.onError` answers that word for one that will not parse. It was missing for as
 * long as this schema has existed: the description promised eight reasons at 400 and the
 * surface answered a ninth (#149).
 */
const CART_REASONS = {
  ...REQUEST_REASONS,
  "secret-key-required": "secret-key-required",
  "cart-not-found": "cart-not-found",
  "cart-expired": "cart-expired",
  "cart-placed": "cart-placed",
  "line-item-not-found": "line-item-not-found",
  "variant-not-found": "variant-not-found",
  "variant-not-priced": "variant-not-priced",
} as const satisfies { [R in CartRefusalReason | RequestReason]: R };

export const CartRefusal = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.enum(CART_REASONS).meta({
      description: "Machine-readable. Branch on this.",
    }),
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
 * An Adjustment on the **Order as a whole**, and the only kind that carries a tax (#117).
 *
 * A delivery surcharge belongs to no line, so no Line Item's `tax` can hold what it was taxed —
 * this is where a tax Step puts that figure, and the Order's `total` accounts for it. A line's
 * Adjustments are an `OrderAdjustment` and have no `tax`, because a line is taxed *after* its
 * Adjustments are applied and so their tax is already inside the line's own.
 *
 * The alternative was one tax figure beside the Order's `total`. It was rejected because a
 * receipt shows tax against the thing that bore it and a Return refunds one surcharge at a time,
 * neither of which a lump sum can answer — `core_order_adjustment.tax` in `db/schema.ts` carries
 * the argument in full.
 */
export const OrderLevelAdjustment = OrderAdjustment.extend({
  tax: z.int().meta({
    description:
      "Tax on this Adjustment, in minor units, signed with `amount`. Zero until a tax Step is wired. A line's own Adjustments carry no such figure: a line is taxed after they are applied, so their tax is inside the line's `tax`.",
  }),
}).openapi("OrderLevelAdjustment");

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
        "What was charged, in minor units — every Line Item's total, plus the Order's own Adjustments and the tax on each of them.",
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
/**
 * A **Fulfilment** — how one part of an Order gets to the Shopper (ADR-0014).
 *
 * One per way this Order is delivered rather than a status on the Order, because a mixed Order
 * ships a poster and emails a PDF and those do not share a timeline. Nothing here moves yet:
 * fulfilling is its own spec, and this is the record it will be written against.
 *
 * The three booleans are what the Fulfilment Strategy **answered at Capture**, copied rather
 * than looked up — a Project may rewire a Strategy or remove the Plugin that offered one, and an
 * Order is immutable.
 */
export const Fulfilment = z
  .object({
    id: z.uuid(),
    strategy: z.string().meta({
      description:
        "The Fulfilment Strategy that produced this, by the name the deployment wired it under. Not a closed set: `physical` and `digital` are Core's, and a Plugin's is whatever the Project called it.",
    }),
    requiresShipping: z.boolean().meta({
      description: "Whether this part goes anywhere physical, as at Capture.",
    }),
    tracksInventory: z.boolean().meta({
      description:
        "Whether selling this took something off a shelf, as at Capture. `false` is why a digital line holds no Reservation.",
    }),
    hasLeadTime: z.boolean().meta({
      description:
        "Whether there is an interval between Capture and delivery. `true` is a made-to-order line; how long is the Plugin's to know, and reaches the Order as an Adjustment.",
    }),
    lineItemIds: z.array(z.uuid()).readonly().meta({
      description:
        "The Line Items this Fulfilment covers, in the SKU order the Order reports its lines in. Every line of an Order kobai placed is in exactly one.",
    }),
  })
  .openapi("Fulfilment");

export const Order = OrderSummary.extend({
  lineItems: z.array(OrderLineItem).readonly().meta({
    description:
      "In SKU order, the way a Product reports its Variants — not the order they were added to the Cart. Read a line by its `sku` rather than by position.",
  }),
  adjustments: z.array(OrderLevelAdjustment).readonly().meta({
    description:
      "The Adjustments on the Order as a whole — the ones belonging to no single line, such as a basket-wide voucher or a delivery surcharge. A line's own are on the line. These are the ones that carry a `tax` of their own, because there is no Line Item whose tax could carry it.",
  }),
  fulfilments: z.array(Fulfilment).readonly().meta({
    description:
      "How this Order gets to the Shopper — one per way, on independent timelines, because a mixed Order ships a poster and emails a PDF. Empty for an Order placed before Fulfilment existed.",
  }),
  metadata: Metadata,
}).openapi("Order");

/** The list, in an envelope — the same shape, and the same reason, as `ProductList`. */
export const OrderList = z
  .object({ orders: z.array(OrderSummary).readonly(), nextCursor: NextCursor })
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
    // No `.meta()` here: this field emits a `$ref`, and a description on it would replace
    // `OpenMetadata`'s own rather than sit beside it. The schema says the whole thing.
    metadata: OpenMetadata.optional(),
  })
  .openapi("PlaceOrderRequest");

/**
 * The ways this route turns a body back before the Workflow runs, as a **closed set**.
 *
 * {@link PlaceOrderRefusal} below leaves `reason` a bare string, which is right where the
 * reasons come from a Step and Core cannot enumerate them. These are Core's own — the two
 * {@link InvalidRequest} carries for every route with a body, plus a key sent in both halves of
 * the open context — so a client can narrow on the difference, which matters because the fixes
 * are different: one body cannot be read, one reads and does not fit, and one puts a key in the
 * wrong place.
 *
 * `invalid` and `malformed-body` are answered above this route rather than by it; the enum has
 * to carry them for that reason, and declaring them here does not make the hook or the error
 * handler this route's.
 */
export const PlaceOrderRequestRefusal = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.enum({ ...REQUEST_REASONS, "metadata-in-both": "metadata-in-both" }),
  })
  .openapi("PlaceOrderRequestRefusal");

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
/**
 * Every reason of Core's own this route can carry — three unions' worth, and it takes all three.
 *
 * `place-order`'s Steps refuse with the first; `resolve-price`'s travel out of `price-lines` as
 * themselves so that a Plugin's Step can do the same; and the last two are made *before* any
 * Workflow runs, by the idempotency key, which is why they are not in either. `store.ts`'s
 * status maps carry the same three unions for the same reason, and go red in the same way.
 */
const PLACE_ORDER_REASONS = {
  "cart-not-found": "cart-not-found",
  "cart-expired": "cart-expired",
  "cart-placed": "cart-placed",
  "cart-empty": "cart-empty",
  "insufficient-inventory": "insufficient-inventory",
  "variant-not-found": "variant-not-found",
  "price-not-set": "price-not-set",
  "payment-declined": "payment-declined",
  "no-payment-provider": "no-payment-provider",
  "unknown-fulfilment-strategy": "unknown-fulfilment-strategy",
  "idempotency-key-reused": "idempotency-key-reused",
  "idempotency-key-in-progress": "idempotency-key-in-progress",
} as const satisfies {
  [R in PlaceOrderReason | PriceResolutionRefusal | IdempotencyRefusal]: R;
};

export const PlaceOrderRefusal = z
  .object({
    error: z.string(),
    reason: stepReason(PLACE_ORDER_REASONS),
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
