import { z } from "@hono/zod-openapi";
import {
  API_KEY_KINDS,
  type ApiKeyCreation,
  type ApiKeyRejection,
} from "../auth/api-key.ts";
import type { MerchantCreation, MerchantUpdate } from "../auth/merchant.ts";
import type { RoleCreation, RoleDeletion, RoleUpdate } from "../auth/role.ts";
import type { SessionPolicy, SessionRejection } from "../auth/session.ts";
import type { CartRefusal as CartRefusalReason } from "../cart/write.ts";
import type {
  CollectionCreation,
  CollectionDeletion,
  CollectionUpdate,
} from "../catalog/collection.ts";
import type {
  PriceDeletion,
  ProductDeletion,
  VariantDeletion,
} from "../catalog/delete.ts";
import { PRODUCT_STATUSES } from "../catalog/status.ts";
import type { StoreCatalogRefusal as StoreCatalogReason } from "../catalog/store-read.ts";
import type { ProductUpdate, VariantUpdate } from "../catalog/update.ts";
import type {
  PriceCreation,
  ProductCreation,
  VariantCreation,
} from "../catalog/write.ts";
import {
  DEFAULT_PAGE_LIMIT,
  decodeCursor,
  MAX_PAGE_LIMIT,
  type PagedList,
} from "../db/page.ts";
import type { MediaUploadOutcome } from "../media/media.ts";
import type { IdempotencyRefusal } from "../order/idempotency.ts";
import type { PlaceOrderRefusal as PlaceOrderReason } from "../order/place-order.ts";
import type { QuoteCartRefusal as QuoteCartReason } from "../order/quote-cart.ts";
import type { PriceResolutionRefusal } from "../pricing/resolve-price.ts";
import type { HoldCartRefusal } from "../reservation/hold-cart.ts";
import type { InventoryUpdate } from "../reservation/inventory.ts";
import type {
  ChannelCreation,
  ChannelDeletion,
  ChannelUpdate,
} from "../store/channel.ts";
import type { RegionCreation, RegionDeletion, RegionUpdate } from "../store/region.ts";
import type { StoreUpdate } from "../store/write.ts";
import { STEP_ORIGINS } from "../workflow/workflow.ts";

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
 * A surface where some lists page and others do not is one a client has to learn twice, so this
 * is written once and called by each list route rather than spelled per route. Both parameters
 * are optional: a caller that sends neither gets the first page at the default size, which is
 * why adding this to a list that returned everything breaks nobody.
 *
 * There is deliberately **no `offset` and no total**. An offset is evaluated against the
 * table as it is when the page is fetched, so an insert between two pages skips or repeats a
 * row without saying so; a total is a second query over the whole table, and it is wrong by
 * the time it is rendered on exactly the tables large enough to want one.
 *
 * **`after` is decoded here rather than in a handler**, so an unusable cursor is answered
 * `invalid` at 400 by the same hook that answers a body that does not fit — and so what a
 * handler receives is a position rather than a string it would have to check again.
 *
 * **A factory rather than a constant, so that the schema knows its own list** (#183). The
 * parameters are identical for every list and the *cursor* is not: one issued by Products is
 * refused by Orders, which needs the reading end to know which list is asking. Naming it here
 * settles the writing end too — the name travels to the reader on its {@link PageRequest} and
 * is what `takePage` stamps into the next cursor — so one call decides both directions and
 * there is no second place to keep in step.
 *
 * This builds a schema per list where the session schema builds one per instance, and it stays
 * inside the same boundary: what varies is which list a cursor belongs to, never which
 * parameters exist or what they mean. A description that enumerated different *paths* per
 * deployment would not be a contract; five copies of one contract, each bound to its own list,
 * is the same contract five times.
 *
 * **A list that also filters passes its filter through here too** — {@link CartPageQuery} is the
 * one that does. It goes through {@link pageQueryOf} rather than assembling the pieces itself,
 * because the whole point of naming a list once is that there is no second place to keep in
 * step: a schema built from `pageParameters("carts")` and stamped by another list's name would
 * typecheck and would issue cursors nothing accepts.
 */
export function pageQuery(list: PagedList) {
  return pageQueryOf(list, {});
}

/**
 * One list's query: ADR-0064's two parameters, whatever that list narrows by, and its name.
 *
 * **The list is named once, and this is where both ends of it are settled** (#183): the same
 * argument decides which cursors {@link decodeCursor} will accept and which name `takePage`
 * stamps into the next one. Everything a route adds is a *filter* — never another parameter with
 * a meaning of its own for paging — so the contract above stays the same contract on every list.
 */
function pageQueryOf<Filters extends z.ZodRawShape>(list: PagedList, filters: Filters) {
  return (
    z
      .object({ ...pageParameters(list), ...filters })
      // The list travels with the request rather than beside it, so a reader is handed which
      // list it is reading and cannot page one under another's name. It is not a parameter and
      // never appears as one: this transform runs after the query string has been read, so
      // `?list=orders` reaches nothing.
      .transform((query) => ({ ...query, list }))
  );
}

/** `limit` and `after`, which are ADR-0064's two and the whole of what every list takes. */
function pageParameters(list: PagedList) {
  return {
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
        const cursor = decodeCursor(list, raw);
        if (cursor === undefined) {
          ctx.addIssue({
            code: "custom",
            message: `not a cursor \`${list}\` issued — an \`after\` has to be a \`nextCursor\` this same list handed back`,
          });
          return z.NEVER;
        }
        return cursor;
      })
      .optional()
      .meta({
        description:
          "The `nextCursor` of the previous page **of this same list**. **Opaque** — it is not an identifier, not a timestamp, and nothing about what is inside it is promised, beyond its being refused by any other list. Send it back exactly as it was received; omit it for the first page.",
      }),
  };
}

/**
 * The field every list answers beside its items, and the only end-of-list signal there is.
 *
 * **Absent** rather than `null` when there is nothing further, because a client that has to
 * tell "no more" from "not asked" is being told the same thing twice. And absence rather than
 * a short page: a page can be short for other reasons — `GET /admin/carts`'s `state` is the
 * first filter on this surface — so a caller that stopped on a short page would stop early.
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

// ---- The deployment -------------------------------------------------------------------

/**
 * Where the Step in a Workflow position came from (ADR-0080).
 *
 * Built from the constant in `workflow/workflow.ts` rather than retyped, so a word added there
 * arrives here — and in `@kobai/client` — instead of quietly widening what the route may
 * answer. A member added to this enum is additive on the wire and is **not** additive for a
 * client that narrowed exhaustively, which is ADR-0060's sharp edge and is owed a release note.
 */
export const StepOrigin = z.enum(STEP_ORIGINS).openapi("StepOrigin");

/**
 * One position in a Workflow, as `GET /admin/deployment` reports it.
 *
 * `origin` is the field this shape exists for. `slot` and `step` agree for a Core default —
 * **and for an inserted Step, and for a replacement that answers to the slot's own name** — so
 * a client comparing them would read two customised deployments as stock. Core records the
 * answer where the rewiring happens and reports it here.
 */
export const DeployedStep = z
  .object({
    slot: z.string().meta({
      description:
        "The position Core declared, and what a `kobai.config.ts` override map is keyed by. Stable across a replacement.",
    }),
    step: z.string().meta({
      description:
        "What the Step filling that position calls itself. Free — a replacement is a different Step and may say so — so it is not a second spelling of `slot`.",
    }),
    origin: StepOrigin.meta({
      description:
        "Where this Step came from: `stock` is Core's own, `replaced` is a Project's Step filling the slot, `inserted` is a Project's Step watching the position without owning it. **Do not derive this from `slot` and `step`**: they are equal for an inserted Step and may be equal for a replacement.",
    }),
  })
  .openapi("DeployedStep");

/** One declared Workflow, and every position in it in the order it runs. */
export const DeployedWorkflow = z
  .object({
    name: z.string().meta({
      description:
        "What the Workflow answers to — `resolve-price`, `place-order` — and the key a Project's `workflows` config uses.",
    }),
    steps: z.array(DeployedStep).readonly().meta({
      description: "Every position, in the order it runs.",
    }),
  })
  .openapi("DeployedWorkflow");

/**
 * What this deployment is: the release, the Workflows, and whether money can move.
 *
 * Three things and deliberately nothing else. The Fulfilment Strategies are
 * `GET /admin/fulfilment-strategies` and the migration sets are `GET /health`, and restating
 * either here would be two descriptions of one fact that can disagree — permanently, since
 * both would be promised (ADR-0060, ADR-0080).
 */
export const Deployment = z
  .object({
    version: z.string().meta({
      description:
        "The release of `@kobai/core` this deployment is running — the same value the OpenAPI description's `info.version` carries, read from Core's own manifest rather than kept as a second copy.",
    }),
    workflows: z.array(DeployedWorkflow).readonly().meta({
      description:
        "Every Workflow this deployment declares, in name order, with the Step occupying each position and where that Step came from. **This list does not page**, for `GET /admin/fulfilment-strategies`' reason: it is what a deployment was configured with rather than a table, so it cannot change while the process runs (ADR-0067).",
    }),
    payments: z
      .object({
        configured: z.boolean().meta({
          description:
            "Whether this deployment was wired with a Payment Provider. `false` is a working deployment that refuses to place an Order with `no-payment-provider` and serves everything else (ADR-0053).",
        }),
      })
      .meta({
        description:
          "An object rather than a bare boolean, so that whatever a provider can one day say about itself arrives beside `configured`. Core ships no provider and reports no name: there is none to report that is not a Project's own variable.",
      }),
  })
  .openapi("Deployment");

/**
 * This deployment's own OpenAPI description — **an open object, deliberately**.
 *
 * An OpenAPI document is a recursive schema kobai does not own, and modelling it in zod would
 * be a second and worse copy of a specification, for a value every consumer feeds to a tool
 * that already knows the shape. So it is described in prose here the way {@link OpenMetadata}
 * is, and a client receives an object it can hand straight to a generator.
 */
export const OpenApiDescription = z
  .record(z.string(), z.unknown())
  .meta({
    description:
      "The OpenAPI 3.1 description of the surface **this server** serves, produced from the routes it is built from rather than read off a package. It describes itself: `/admin/openapi.json` is one of the paths in it. Not served anonymously — publishing which routes a deployment serves, which gates they sit behind and which refusals they make is a decision about a Project's exposure that kobai does not take by default (ADR-0080).",
  })
  .openapi("OpenApiDescription");

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
 * What a Merchant may change about a colleague who already exists — which is their Role, and
 * nothing else (#202, ADR-0066).
 *
 * **The absences are the decision.** There is no `email` and no `password` here, because
 * changing the address a colleague signs in with and setting their password from somebody
 * else's session are two separate questions nobody has answered, and a `PATCH` that carried
 * them would have answered both in passing. What a body naming neither is told names this
 * field and says so, which is the second job ADR-0062 gives that refusal.
 *
 * The Role is named **by name**, as {@link CreateMerchantRequest} names it, so one surface
 * spells one thing one way — and so a Role renamed between a picker being read and this being
 * submitted is refused `unknown-role` rather than silently moving the Merchant somewhere else.
 *
 * **`role` is optional although it is the only field**, which reads like an oversight and is
 * ADR-0062's shape: on every `PATCH` here an absent field means "leave it", and the emptiness is
 * a *rule* the handler answers with the sentence every other correction shares — not a schema
 * violation the edge reports in its own words. Required, `{}` would be turned back by the
 * request hook before the handler ran, and this route would be the one correction on the
 * surface that refuses a no-op differently from the rest.
 */
export const UpdateMerchantRequest = z
  .object({
    role: z.string().optional().meta({
      description:
        "A Role by name — the one this Merchant is to hold. It takes effect on their very next request, signed in or not, because a Role is read on each one rather than copied into the session. Naming the Role they already hold is accepted and changes nothing.",
    }),
  })
  .openapi("UpdateMerchantRequest");

/**
 * Every way a Merchant can be refused, as a closed set.
 *
 * The keys are checked against `createMerchant`'s and `updateMerchant`'s own unions, so a fifth
 * way to refuse a Merchant has no key here and does not compile — the guarantee
 * {@link SessionRefusal} gets from `SessionRejection`, applied to a handler's refusals instead
 * of a gate's.
 *
 * **`last-administrator` is here as well as in {@link RoleRefusal}, and it is deliberately the
 * same word.** It names one fact about the deployment — that nobody would be left holding
 * `merchant:write` — which two different acts can now bring about: narrowing the Role that
 * carries it, and moving the last Merchant who holds it off that Role. A second word for the
 * second act would make a client branch twice on one state (ADR-0066).
 */
const MERCHANT_REASONS = {
  ...REQUEST_REASONS,
  "unknown-role": "unknown-role",
  "email-taken": "email-taken",
  "merchant-not-found": "merchant-not-found",
  "last-administrator": "last-administrator",
} as const satisfies {
  [R in Refused<MerchantCreation> | Refused<MerchantUpdate> | RequestReason]: R;
};

export const MerchantRefusal = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.enum(MERCHANT_REASONS).meta({
      description: "Machine-readable. Branch on this.",
    }),
  })
  .openapi("MerchantRefusal");

/**
 * The list, in an envelope — the Merchants of this deployment, and how to ask for the rest.
 *
 * Each carries the Role it holds rather than an identifier for one, because *who has access*
 * is the question this list is asked: a client that had to fetch a Role per row would be
 * asking it twice.
 */
export const MerchantList = z
  .object({ merchants: z.array(Merchant).readonly(), nextCursor: NextCursor })
  .openapi("MerchantList");

/**
 * A Role as this surface reports it — the name a Merchant is created against, and what it
 * carries (ADR-0027).
 *
 * `permissions` is an array of plain strings and is **not** an enum of Core's own. Closing it
 * would contradict {@link RoleSummary}'s description one field away, which already promises
 * that a deployment may hold a Permission this build has never heard of, and would foreclose
 * a Plugin-supplied Permission before anybody has designed one (ADR-0066).
 */
export const Role = z
  .object({
    id: z.uuid(),
    name: z.string(),
    permissions: z.array(z.string()).readonly().meta({
      description:
        "What a Merchant holding this Role may do. Core's own are listed in `PermissionDenied.required`'s description; a word Core does not know is stored and answered back unchanged, so a Plugin's Permission is a string like any other.",
    }),
    metadata: Metadata,
  })
  .openapi("Role");

export const RoleList = z
  .object({ roles: z.array(Role).readonly(), nextCursor: NextCursor })
  .openapi("RoleList");

export const CreateRoleRequest = z
  .object({
    name: z.string().meta({
      description:
        "How a Merchant is created against this Role, so no two Roles may share one.",
    }),
    permissions: z.array(z.string()).optional().meta({
      description:
        "Defaults to none, which is a Role that can sign in and reach nothing. Each entry must be a non-empty string and nothing more is checked — an unknown word is preserved rather than refused.",
    }),
    metadata: Metadata.optional(),
  })
  .openapi("CreateRoleRequest");

/**
 * What a Merchant may change about a Role that already exists.
 *
 * The same `PATCH` {@link UpdateProductRequest} and {@link UpdateVariantRequest} are: **every
 * field is optional and each one absent means "leave it"**, a named `metadata` **replaces**
 * what is stored, and a body naming none of them is refused rather than answered with the row
 * unchanged.
 *
 * A named `permissions` replaces the whole set, because a set is what it is — there is
 * deliberately no add-one and no remove-one, which would be two more spellings of this field
 * and each would need its own answer to the lockout below.
 */
export const UpdateRoleRequest = z
  .object({
    name: z.string().optional().meta({
      description:
        "A new name for this Role. Merchants hold a Role by identifier, so renaming one moves every Merchant with it; what it breaks is a `POST /admin/merchants` that names the old one.",
    }),
    permissions: z.array(z.string()).optional().meta({
      description:
        "Replaces the whole set rather than adding to it. It takes effect on the next request every Merchant holding this Role makes — a Role is read on each one, not cached into the session.",
    }),
    metadata: Metadata.optional().meta({
      description: "Replaces what is stored rather than merging into it.",
    }),
  })
  .openapi("UpdateRoleRequest");

/**
 * Every way a Role can be refused, as a closed set.
 *
 * `last-administrator` is the one refusal on this surface that is about rows the request never
 * named: it is answered when a change would leave no Merchant holding `merchant:write`, which
 * is a deployment with no way back into itself (ADR-0066).
 */
const ROLE_REASONS = {
  ...REQUEST_REASONS,
  "role-not-found": "role-not-found",
  "role-name-taken": "role-name-taken",
  "role-in-use": "role-in-use",
  "last-administrator": "last-administrator",
} as const satisfies {
  [R in
    | Refused<RoleCreation>
    | Refused<RoleUpdate>
    | Refused<RoleDeletion>
    | RequestReason]: R;
};

export const RoleRefusal = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.enum(ROLE_REASONS).meta({
      description: "Machine-readable. Branch on this.",
    }),
  })
  .openapi("RoleRefusal");

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
  channelId: z.uuid().nullable().meta({
    description:
      "Which Channel a request presenting this key is in, or `null` for a key that is in no particular one — which is what every key minted without one is. It is decided here and never again: a storefront does not thread a Channel through its requests and cannot claim to be in one it was not issued a credential for (ADR-0020).",
  }),
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
    channelId: z.uuid().optional().meta({
      description:
        "The Channel every request presenting this key is in, as `GET /admin/channels` lists them. **Left out is unconstrained** — a key in no particular Channel, which is what every key minted before Channels existed is — and it is the right answer for a deployment that sells through one route to market. A Channel this Store has not got is refused at 422 with `channel-not-found`. It cannot be changed afterwards: mint another key and revoke this one.",
    }),
  })
  .openapi("CreateApiKeyRequest");

/**
 * Every way minting a key can be refused, as a closed set (#291).
 *
 * A family where minting used to answer {@link InvalidRequest}'s two, because there is now one
 * way to get it wrong that is a fact about the **Store** rather than about the body: a
 * `channelId` naming a Channel this Store has not got. That is 422 on `collection-not-found`'s
 * distinction, and it is the same word `GET /admin/channels/{id}` answers 404 with.
 *
 * It is deliberately not {@link ApiKeyNotFound}'s and not {@link ApiKeyRefusal}'s. The first is
 * a Merchant addressing a key that does not exist and the second is the *gate* rejecting a
 * credential a storefront presented; sharing either would tell a client that two very different
 * failures are one condition.
 */
const MINT_API_KEY_REASONS = {
  ...REQUEST_REASONS,
  "channel-not-found": "channel-not-found",
} as const satisfies { [R in Refused<ApiKeyCreation> | RequestReason]: R };

export const MintApiKeyRefusal = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.enum(MINT_API_KEY_REASONS).meta({
      description: "Machine-readable. Branch on this.",
    }),
  })
  .openapi("MintApiKeyRefusal");

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

/**
 * One currency this Store may price in (#291, ADR-0074).
 *
 * **An object rather than a bare code**, for {@link MediaAttachment}'s reason: enabling a
 * currency is the sort of thing that grows a setting — a rounding rule, a display format — and
 * one then arrives as a field beside this, where a list of strings could only grow by changing
 * the type of every element (ADR-0060). It is why the enabled set is rows rather than a `jsonb`
 * array on the Store.
 */
export const EnabledCurrency = z
  .object({
    code: z.string().meta({ description: "ISO 4217, upper case — `USD`, `MYR`." }),
  })
  .openapi("EnabledCurrency");

/**
 * A **Region** — a geography this Store sells into (#291, ADR-0005, ADR-0074).
 *
 * Three fields, and what is absent is what the next two specs bring: tax treatment is spec 7 and
 * shipping methods are spec 5, and both hang off this row when they arrive. It **selects** a
 * currency rather than declaring one — the Store enumerates what may be priced in, a Region
 * names one of those — and ADR-0074 is where that division is argued.
 *
 * **A Region is not a tenant, and this is the spec most likely to be read as an invitation.**
 * ADR-0005 is explicit: variation *within* one Store. Nothing is scoped by a Region and nothing
 * will be.
 */
export const Region = z
  .object({
    id: z.uuid(),
    name: z.string().meta({
      description:
        "What the Merchant calls it — `Malaysia`, `Eurozone`. **Not unique**: a Region is addressed by its identifier everywhere, so two carrying one name are two geographies rather than a collision.",
    }),
    currency: z.string().meta({
      description:
        "The ISO 4217 code this Region prices in, which is always one of the currencies `GET /admin/store` reports. kobai converts nothing, ever: a Variant with no Price in this currency has no price here.",
    }),
    metadata: Metadata,
  })
  .openapi("Region");

/**
 * A Region as everything that is *not* the Region routes reports one — what it is called and
 * what it prices in (#292).
 *
 * **A second component for one noun, deliberately**, and {@link VariantIdentity} is the
 * precedent: a Price and a resolved price name the Region they apply in, and what a reader
 * needs there is the name and the currency rather than the Merchant's `metadata` bag repeated
 * on every row. Publishing the whole `Region` in those places would put that bag on the store
 * surface, where #207's split says a field reaches a browser only because somebody put it there.
 */
export const RegionIdentity = z
  .object({
    id: z.uuid(),
    name: z.string().meta({ description: "What the Merchant calls it — `Malaysia`." }),
    currency: z.string().meta({
      description:
        "The ISO 4217 code this Region prices in. A Price denominated in anything else does not apply here, and kobai converts nothing.",
    }),
  })
  .openapi("RegionIdentity");

/** The list, in an envelope — the items, and how to ask for what follows them (ADR-0064). */
export const RegionList = z
  .object({ regions: z.array(Region).readonly(), nextCursor: NextCursor })
  .openapi("RegionList");

/** ADR-0064's two parameters and nothing else: this list narrows by nothing. */
export const RegionPageQuery = pageQuery("regions");

export const CreateRegionRequest = z
  .object({
    name: z.string().meta({ description: "Required, and not empty." }),
    currency: z.string().meta({
      description:
        "Required. An ISO 4217 code this Store has **enabled**, read case-insensitively — `GET /admin/store` lists them and `PATCH /admin/store` enables another. One this Store has not enabled is refused at 422 with `currency-not-enabled`.",
    }),
    metadata: Metadata.optional(),
  })
  .openapi("CreateRegionRequest");

/**
 * Name what should change; naming nothing is refused rather than treated as a no-op (ADR-0062).
 *
 * **A Region's currency moves and the Store's does not**, which is the asymmetry to read twice.
 * The Store's default denominates every unconstrained Price, so moving it reinterprets those
 * amounts (ADR-0065); a Region *selects*, so moving the selection changes which Prices apply to
 * it rather than what any of them means.
 */
export const UpdateRegionRequest = z
  .object({
    name: z.string().optional(),
    currency: z.string().optional().meta({
      description:
        "An ISO 4217 code this Store has enabled, read case-insensitively. One it has not is refused at 422 with `currency-not-enabled`.",
    }),
    metadata: Metadata.optional().meta({
      description: "Replaces what is stored rather than merging into it.",
    }),
  })
  .openapi("UpdateRegionRequest");

/**
 * Every way a Region operation can be refused, as a closed set.
 *
 * The keys are checked against the unions `store/region.ts` declares, so a rename there turns
 * *this* red naming the reason.
 */
const REGION_REASONS = {
  ...REQUEST_REASONS,
  "region-not-found": "region-not-found",
  "currency-not-enabled": "currency-not-enabled",
  "region-in-use": "region-in-use",
} as const satisfies {
  [R in
    | Refused<RegionCreation>
    | Refused<RegionUpdate>
    | Refused<RegionDeletion>
    | RequestReason]: R;
};

export const RegionRefusal = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.enum(REGION_REASONS).meta({
      description: "Machine-readable. Branch on this.",
    }),
  })
  .openapi("RegionRefusal");

/**
 * A **Channel** — a route to market this Store sells through (#291, ADR-0005).
 *
 * A name, and that is the whole entity. ADR-0005 says kobai's Channel means *sales channel
 * only*, against Vendure's, which overloads the same word to mean tenant boundary: so a Channel
 * carries no scope, owns nothing, and is referenced by two columns — an API key's, which is how
 * a request's Channel is decided (ADR-0020), and a Price's, which is what varies per Channel.
 */
export const Channel = z
  .object({
    id: z.uuid(),
    name: z.string().meta({
      description:
        "What the Merchant calls it — `Web`, `Marketplace`. **Not unique**: a Channel is addressed by its identifier everywhere.",
    }),
    metadata: Metadata,
  })
  .openapi("Channel");

/** A Channel as a Price and a resolved price name one. {@link RegionIdentity}'s argument (#292). */
export const ChannelIdentity = z
  .object({
    id: z.uuid(),
    name: z.string().meta({ description: "What the Merchant calls it — `Marketplace`." }),
  })
  .openapi("ChannelIdentity");

/** The list, in an envelope — the items, and how to ask for what follows them (ADR-0064). */
export const ChannelList = z
  .object({ channels: z.array(Channel).readonly(), nextCursor: NextCursor })
  .openapi("ChannelList");

/** ADR-0064's two parameters and nothing else: this list narrows by nothing. */
export const ChannelPageQuery = pageQuery("channels");

export const CreateChannelRequest = z
  .object({
    name: z.string().meta({ description: "Required, and not empty." }),
    metadata: Metadata.optional(),
  })
  .openapi("CreateChannelRequest");

/**
 * Name what should change; naming nothing is refused rather than treated as a no-op (ADR-0062).
 *
 * **There is deliberately no list of API keys here.** Which keys are in a Channel is decided
 * when each is minted (`POST /admin/api-keys`), and a second field writing that fact from this
 * side would be permanent under ADR-0060 and could disagree with the first.
 */
export const UpdateChannelRequest = z
  .object({
    name: z.string().optional(),
    metadata: Metadata.optional().meta({
      description: "Replaces what is stored rather than merging into it.",
    }),
  })
  .openapi("UpdateChannelRequest");

/**
 * Every way a Channel operation can be refused, as a closed set.
 *
 * The smallest family on this surface beside a Collection's, and for the same kind of reason: a
 * Channel's name is not unique, so nothing conflicts, and deleting one is refused for nothing —
 * the keys that named it become unconstrained rather than losing anything.
 */
const CHANNEL_REASONS = {
  ...REQUEST_REASONS,
  "channel-not-found": "channel-not-found",
} as const satisfies {
  [R in
    | Refused<ChannelCreation>
    | Refused<ChannelUpdate>
    | Refused<ChannelDeletion>
    | RequestReason]: R;
};

export const ChannelRefusal = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.enum(CHANNEL_REASONS).meta({
      description: "Machine-readable. Branch on this.",
    }),
  })
  .openapi("ChannelRefusal");

/** No identifier, because there is only one (ADR-0005). */
export const Store = z
  .object({
    name: z.string(),
    defaultCurrency: z.string().meta({
      description:
        "ISO 4217, upper case. What a Price carrying no Region and no Channel is denominated in, and it does not move (ADR-0065). It is always one of `currencies`.",
    }),
    currencies: z.array(EnabledCurrency).readonly().meta({
      description:
        "Every currency this Store may price in, by code — the vocabulary a Region selects from and a Price is denominated in (ADR-0074). Always includes `defaultCurrency`, which is why disabling that one is refused. Enabling a currency is not the same as having Prices in it: kobai converts nothing.",
    }),
    // **A union rather than `Region.nullable()`**, and that is not a style choice: `.nullable()`
    // at a *reference* site is applied to the registered component itself, so `Region` would be
    // published as `object | null` — and `GET /admin/regions` would then promise a page of items
    // that may each be `null`, which is a thing no handler produces and, under ADR-0060, a
    // `null` a client is entitled to expect for ever. **This is the canonical statement of that
    // rule** — every other site in this file points here rather than restating it — and it is
    // enforced rather than remembered: `openapi.test.ts` sweeps every registered component of
    // the generated description and fails naming any that admits `null` (#309). `Inventory`,
    // `CartShopper` and `Payment` were each published that way until that sweep existed.
    // The `description` goes on the union for the same reason — a `.meta()` there would have
    // overwritten the Region's own.
    defaultRegion: z.union([Region, z.null()]).meta({
      description:
        "The Region a storefront that names none is answered for. Seeded at the first boot after this Store was created, from `defaultCurrency`, and renamed like any other Region; `null` only on a deployment whose Project never seeds one.",
    }),
    metadata: Metadata,
  })
  .openapi("Store");

/**
 * What a Merchant may change about the Store — and, in `defaultCurrency`'s case, what they may
 * name and not move.
 *
 * The same `PATCH` both catalog ones are: **every field is optional, each one absent means
 * "leave it"**, and a named `metadata` **replaces** what is stored rather than merging into it.
 * A body naming nothing that would change is refused rather than answered 200.
 *
 * **`defaultCurrency` is accepted so that it can be refused by name.** A form that submits the
 * whole record round-trips — the code this Store already prices in is taken and changes
 * nothing — and any *other* code is refused, because every Price already written carries the
 * current one and moving the column would reinterpret each of those amounts rather than
 * convert them. Leaving the field out of this schema would have collapsed that into the
 * generic "you named nothing" refusal, where a Merchant could not tell a rule from an
 * oversight.
 */
export const UpdateStoreRequest = z
  .object({
    name: z.string().optional().meta({
      description: "What this Store is called. Free to change; nothing is keyed by it.",
    }),
    defaultCurrency: z.string().optional().meta({
      description:
        "ISO 4217, read case-insensitively. **Only the code this Store already prices in is accepted**, and naming it changes nothing: a Price carrying no Region and no Channel is denominated in it (ADR-0074), so changing this would reinterpret each of those amounts rather than convert them. Another currency is refused with `default-currency-is-fixed` — it is *enabled* in `currencies` and selected on a Region instead. Because naming the current one changes nothing, a body naming *only* this field is refused as a request that changes nothing — send it beside a `name` or a `metadata`.",
    }),
    // The **same shape** the read answers with, and that is the point rather than a symmetry
    // for its own sake: {@link EnabledCurrency} is an object so that a per-currency setting can
    // arrive beside `code` and be additive (ADR-0060), and a request taking bare strings would
    // have exactly the problem the response was shaped to avoid — the day such a setting exists,
    // this is where a Merchant would have to send it. `collections` on a Product takes
    // `{ id }`s for the same reason.
    currencies: z.array(EnabledCurrency).optional().meta({
      description:
        "**The complete list** of the currencies this Store may price in — so this is where one is enabled and where one is disabled, and an entry left out is a currency taken away. Each `code` is read case-insensitively. `defaultCurrency` has to be among them: leaving it out is refused with `default-currency-must-be-enabled`, because a Price carrying no Region and no Channel is denominated in it. A code a Region selects cannot be taken away either — that is `currency-in-use`, naming the Regions, and the repair is to move or delete them first.",
    }),
    defaultRegion: z.uuid().optional().meta({
      description:
        "The `id` of the Region a storefront that names none is answered for — `GET /admin/regions` lists them. One this Store has not got is refused with `region-not-found`. There is no way to say *no default Region*: a deployment is seeded one at its first boot, and taking it away would leave every storefront that sends no Region refused instead.",
    }),
    metadata: Metadata.optional().meta({
      description: "Replaces what is stored rather than merging into it.",
    }),
  })
  .openapi("UpdateStoreRequest");

/**
 * Every way a Store operation can be refused, as a closed set.
 *
 * Two routes and one of them refuses nothing, so this is `PATCH /admin/store`'s set: the
 * request's own two, and the one word that is a fact about the Store rather than about the
 * request. It is a family of its own rather than a reuse of {@link CatalogRefusal} because a
 * Price and a Store are different subjects — and because a client narrowing on this one should
 * not be handed `last-variant` to think about.
 */
const STORE_REASONS = {
  ...REQUEST_REASONS,
  "default-currency-is-fixed": "default-currency-is-fixed",
  "default-currency-must-be-enabled": "default-currency-must-be-enabled",
  "currency-in-use": "currency-in-use",
  "region-not-found": "region-not-found",
} as const satisfies { [R in Refused<StoreUpdate> | RequestReason]: R };

export const StoreRefusal = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.enum(STORE_REASONS).meta({
      description: "Machine-readable. Branch on this.",
    }),
  })
  .openapi("StoreRefusal");

// ---- Media ------------------------------------------------------------------------------

/**
 * One Merchant-supplied catalog asset, as every route reports it (ADR-0015).
 *
 * **`url` is the whole of what a client is told about where the bytes are, and there is no
 * storage key on this shape.** The address is the deployment's `MediaStorage`'s answer, asked
 * fresh on every read rather than stored — so a Store that puts a CDN in front of its bucket
 * changes one line of `kobai.config.ts` and every Media it has ever recorded reports the new
 * address. Publishing the key instead would promise a client something only that one storage
 * can interpret, permanently (ADR-0060).
 *
 * It may be **absolute or root-relative**, and a client has to handle both because both are
 * ordinary: a bucket answers `https://…` and the storage Core ships answers `/media/{key}`,
 * which is kobai's own open byte route.
 */
export const Media = z
  .object({
    id: z.uuid(),
    url: z.string().meta({
      description:
        "Where the bytes are. Absolute for a deployment whose `MediaStorage` has an address of its own — a bucket, a CDN — and root-relative (`/media/…`) for the storage kobai ships, whose bytes kobai serves. Asked of the storage on every read rather than stored, so it moves with the deployment's configuration; a client renders it and parses none of it.",
    }),
    contentType: z.string().meta({
      description:
        "What the upload declared the bytes are — `image/png`. Served back verbatim by the byte route, and never sniffed.",
    }),
    filename: z.string().meta({
      description:
        "The name the file had on the machine it was uploaded from, so a Media library reads as one. It is not part of the address and nothing resolves it.",
    }),
    byteSize: z.int().meta({ description: "How many bytes were stored." }),
    width: z.int().nullable().meta({
      description:
        "The image's own width in pixels, read out of its header — or `null` where kobai could not read it, which is every format but PNG, JPEG, GIF and WebP. `null` rather than `0`, so a storefront can tell *unknown* from a measurement and reserve space only when it really knows.",
    }),
    height: z.int().nullable().meta({ description: "Likewise, in pixels, or `null`." }),
    alt: z.string().nullable().meta({
      description:
        "What this shows, for a Shopper who cannot see it — or `null` where nobody has written it yet. Never an empty string: that is what a *decorative* image says, and it is a different fact from nobody having been asked.",
    }),
  })
  .openapi("Media");

/** The list, in an envelope — the items, and how to ask for what follows them (ADR-0064). */
export const MediaList = z
  .object({ media: z.array(Media).readonly(), nextCursor: NextCursor })
  .openapi("MediaList");

/** ADR-0064's two parameters and nothing else: this list narrows by nothing yet. */
export const MediaPageQuery = pageQuery("media");

/**
 * What the open byte route is addressed by — the storage's own key, not a kobai identifier.
 *
 * A plain string for {@link IdParam}'s reason and one of its own: what a key may look like is
 * the deployment's `MediaStorage`'s business, and a schema narrowing it here would be kobai
 * forming an opinion about a value it promises to treat as opaque. A key nothing was stored
 * under is `media-not-found`, which is the same answer a key that never existed gets.
 */
export const MediaKeyParam = z.object({
  key: z.string().meta({
    description:
      "The storage key, as it appears in the `url` a Media reported. Opaque: it is whatever this deployment's `MediaStorage` called the object.",
  }),
});

/**
 * What an upload carries — and it is the surface's first request that is not JSON.
 *
 * **`multipart/form-data`, described honestly**: `file` reaches the description as
 * `type: string, format: binary`, which is what OpenAPI has for bytes, so a generated client and
 * a `curl` line both come out right. The *response* is JSON like everything else here and is
 * typechecked against {@link Media} exactly as every other route's is — the request being binary
 * changes what a caller sends and nothing about what kobai answers.
 *
 * **There is no `metadata` here and no width or height either.** The dimensions are read out of
 * the bytes (`media/dimensions.ts`), because a client-stated size is a claim a storefront would
 * then lay out against.
 */
export const UploadMediaRequest = z
  .object({
    file: z.file().meta({
      type: "string",
      format: "binary",
      description:
        "The bytes, as a file part. kobai stores what it is given: it does not resize, convert or generate thumbnails, and a Project that wants derivatives puts a CDN in front of its `MediaStorage`. An empty file is refused at 400.",
    }),
    alt: z.string().optional().meta({
      description:
        "What this shows, for a Shopper who cannot see it. Left out — or sent empty — the Media has no alt text rather than an empty one.",
    }),
  })
  .openapi("UploadMediaRequest");

/**
 * Every way an upload can be refused, as a closed set (#278).
 *
 * **It became a family the day the route grew a second word.** Until then uploading refused
 * `invalid` alone and declared {@link InvalidRequest}, which is what a route with nothing else
 * to turn back at 400 declares; a ceiling and an accepted set are refusals the *deployment*
 * makes about a well-formed request, so they arrive at 422 — and `refused` answers with one
 * body type across every status a route names, so the 400 and the 422 have to be the same
 * schema. That is `CatalogRefusal`'s construction, arrived at from the same direction.
 *
 * The keys are checked against `uploadMedia`'s own union, so a rename in `media/media.ts` turns
 * this red naming the word rather than quietly regenerating a description that says something
 * else.
 */
const MEDIA_UPLOAD_REASONS = {
  ...REQUEST_REASONS,
  // Two words rather than one, because they are two repairs: a Merchant answers the first by
  // exporting the image smaller and the second by exporting it as something else. What decides
  // both is the Project's `media` key in `kobai.config.ts`, so neither is a fact about kobai
  // that a client could have known in advance — which is why each refusal's prose names the
  // ceiling and the accepted set it was judged against.
  "media-too-large": "media-too-large",
  "content-type-not-accepted": "content-type-not-accepted",
} as const satisfies {
  [R in Refused<MediaUploadOutcome> | RequestReason]: R;
};

export const MediaUploadRefusal = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.enum(MEDIA_UPLOAD_REASONS).meta({
      description: "Machine-readable. Branch on this.",
    }),
  })
  .openapi("MediaUploadRefusal");

/**
 * The one refusal the byte route makes, and its own schema for {@link ApiKeyNotFound}'s reason:
 * a single literal, bound to the handler that writes it by the schema it is typechecked
 * against.
 *
 * It is not a family — reading the list refuses only a page query, and uploading has a family
 * of its own ({@link MediaUploadRefusal}) whose words are about what an upload may be rather
 * than about which asset was asked for.
 */
export const MediaNotFound = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.literal("media-not-found").meta({
      description: "Machine-readable. Branch on this.",
    }),
  })
  .openapi("MediaNotFound");

/**
 * One entry of the list saying what a Product or a Variant shows — an identifier, and nothing
 * else (#255).
 *
 * **An object rather than a bare `uuid`**, for the reason {@link FulfilmentStrategySummary} is
 * one: whatever an attachment one day needs to say for itself — a caption of its own, a role —
 * then arrives as a field beside this one and is additive, where a list of strings could only
 * grow by changing the type of every element (ADR-0060).
 *
 * **There is no `position`.** The order of the array *is* the order, exactly as it is for a
 * Product's options, so nothing has to agree with anything and a Merchant reorders by sending
 * the list in another order.
 */
export const MediaAttachment = z
  .object({
    id: z.uuid().meta({
      description:
        "The Media to show, as `POST /admin/media` answered with and `GET /admin/media` lists. One this Store has no Media for is refused at 422 with `media-not-found`.",
    }),
  })
  .openapi("MediaAttachment");

// ---- Collections ------------------------------------------------------------------------

/**
 * A **Collection** — a Merchant's grouping of Products, and the whole of what one is (#256).
 *
 * Three fields, and the two that are absent are the decisions. **There is no `handle`**: nothing
 * resolves a Collection by name, because a storefront browses one through `?collection=` by the
 * identifier the Product it was already holding reports — the address a Collection is *published*
 * at belongs to the page that renders it, which is the content Plugin's (#216, ADR-0074). And
 * **there is no count of the Products in it**: that is a second question with its own answer
 * (`GET /admin/products?collection=`), and a number beside a name is one that has to be computed
 * on every read of every row of a list.
 *
 * `metadata` is here for the reason every principal entity carries one (ADR-0004): a Project's
 * own copy for a Collection has nowhere else to live until the content Plugin gives it a page.
 */
export const Collection = z
  .object({
    id: z.uuid(),
    title: z.string().meta({
      description:
        "What the Merchant calls it — `Summer`, `Under 20`. **Not unique**: a Collection is addressed by its identifier everywhere, so two carrying one title are two groupings rather than a collision.",
    }),
    metadata: Metadata,
  })
  .openapi("Collection");

/** The list, in an envelope — the items, and how to ask for what follows them (ADR-0064). */
export const CollectionList = z
  .object({ collections: z.array(Collection).readonly(), nextCursor: NextCursor })
  .openapi("CollectionList");

/** ADR-0064's two parameters and nothing else: this list narrows by nothing. */
export const CollectionPageQuery = pageQuery("collections");

export const CreateCollectionRequest = z
  .object({
    title: z.string().meta({ description: "Required, and not empty." }),
    metadata: Metadata.optional(),
  })
  .openapi("CreateCollectionRequest");

/**
 * Name what should change; naming neither is refused rather than treated as a no-op (ADR-0062).
 *
 * **There is deliberately no `products` here.** Which Products are in a Collection is
 * `collections` on `PATCH /admin/products/{id}` — the whole set of the Collections *one Product*
 * is in — and a second field saying the same fact from this side would be permanent under
 * ADR-0060 and could disagree with the first about what an empty list means.
 */
export const UpdateCollectionRequest = z
  .object({
    title: z.string().optional(),
    metadata: Metadata.optional(),
  })
  .openapi("UpdateCollectionRequest");

/**
 * One entry of the set saying which Collections a Product is in — an identifier, and nothing
 * else.
 *
 * **An object rather than a bare `uuid`**, for {@link MediaAttachment}'s reason: whatever a
 * membership one day needs to say for itself arrives as a field beside this one and is additive,
 * where a list of strings could only grow by changing the type of every element (ADR-0060).
 *
 * **There is no `position`, and here that is stronger than it is for Media.** A Product's images
 * are shown in an order a Merchant chose (story 9); a Product's Collections are a **set**, so the
 * order of the array means nothing on the way in and the answer comes back by title.
 */
export const CollectionMembership = z
  .object({
    id: z.uuid().meta({
      description:
        "The Collection this Product should be in, as `POST /admin/collections` answered with and `GET /admin/collections` lists. One this Store has no Collection for is refused at 422 with `collection-not-found`.",
    }),
  })
  .openapi("CollectionMembership");

/**
 * Every way a Collection operation can be refused, as a closed set.
 *
 * Two words past the request ones, and the set is small because a Collection conflicts with
 * nothing: its title is not unique, so there is no `collection-title-taken`, and deleting one is
 * never refused for holding Products — it ungroups them, which is story 17 and the whole point.
 * The keys are checked against the unions `catalog/collection.ts` declares, so a rename there
 * turns *this* red naming the reason.
 */
const COLLECTION_REASONS = {
  ...REQUEST_REASONS,
  "collection-not-found": "collection-not-found",
} as const satisfies {
  [R in
    | Refused<CollectionCreation>
    | Refused<CollectionUpdate>
    | Refused<CollectionDeletion>
    | RequestReason]: R;
};

export const CollectionRefusal = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.enum(COLLECTION_REASONS).meta({
      description: "Machine-readable. Branch on this.",
    }),
  })
  .openapi("CollectionRefusal");

/**
 * `?collection=` — written once here and used by **both** Product lists, which is the whole of
 * what makes them one filter rather than two that happen to agree.
 *
 * **A plain optional string, for {@link IdParam}'s reason.** Declaring it `uuid` would refuse a
 * malformed value with one sentence and a well-formed value naming no Collection with another,
 * for what is one mistake: this parameter takes the identifier of a Collection this Store has,
 * and neither of those is one. So the shape and the existence are judged together, in
 * `catalog/collection.ts`'s `unknownCollection`, and answered with the same `invalid` at 400 that
 * every other unusable query parameter already gets (ADR-0060) — **never with an empty page**,
 * which is the truthful-looking answer the filtering convention exists to rule out.
 *
 * Each caller adds its own `description`, because what narrowing by a Collection means on a
 * Merchant's list and on a storefront's are two sentences: one of them composes with `status`
 * and the other cannot reach a draft at all.
 */
const CollectionFilter = z.string().optional();

// ---- Catalog --------------------------------------------------------------------------

/**
 * A Price — an amount, what it is denominated in, and where it applies (ADR-0008).
 *
 * **`region` and `channel` are the constraint columns ADR-0008 predicted**, and `null` on either
 * means *applies to all* rather than *applies to none* — so every Price written before #292 is
 * the unconstrained fallback, which is what makes this additive for a Store that sells into one
 * market. Which of several Prices a storefront is actually charged is `resolve-price`'s answer
 * and never a row read: best match, on the Region and the Channel, in a Workflow a Project may
 * have replaced.
 *
 * **A union rather than `.nullable()`** on both, for the reason `Store.defaultRegion` carries:
 * `.nullable()` at a reference site is applied to the registered component, so `RegionIdentity`
 * itself would be published as `object | null` and every other route naming one would promise a
 * `null` no handler produces.
 */
export const Price = z
  .object({
    id: z.uuid(),
    amount: z.int().meta({
      description: "Minor units of `currency` — 1250 is USD 12.50.",
    }),
    currency: z.string(),
    region: z.union([RegionIdentity, z.null()]).meta({
      description:
        "The Region this Price applies to, or `null` for **every** Region. A Price constrained to a Region beats an unconstrained one there, and applies nowhere else.",
    }),
    channel: z.union([ChannelIdentity, z.null()]).meta({
      description:
        "The Channel this Price applies to, or `null` for **every** Channel. Which Channel a storefront is in is decided by its API key, so a Price constrained to one applies to the keys minted into it (ADR-0020).",
    }),
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

/**
 * One option a Product is chosen by, as a read reports it.
 *
 * **The identifier is here because `PATCH /admin/products/{id}` addresses one by it**, and that
 * is the only thing it is for: an entry of that body carrying this `id` is the option that
 * already has it, renamed or moved, so a typo fix keeps every Variant's answer attached to it
 * instead of reading as a removal and an addition. {@link StoreProductOption} carries no `id`
 * for exactly that reason — a storefront addresses nothing.
 *
 * There is no `position`: the order of the array **is** the order, so nothing has to agree with
 * anything, and a Merchant reorders by sending the list in another order.
 */
export const ProductOption = z
  .object({
    id: z.uuid(),
    name: z.string().meta({
      description:
        "What this option is called — `Size`, `Colour`. Unique within its Product, because it is what a Variant's values are keyed by.",
    }),
  })
  .openapi("ProductOption");

/**
 * A Variant's value for one of its Product's options — `Size` is `M`.
 *
 * Keyed by the option's **name** rather than by its identifier, on both the way in and the way
 * out. A name is unique within a Product and is what a Merchant and a storefront both read, and
 * it means a create can declare a Product's options and answer them in the same body, where no
 * identifier exists yet.
 */
export const VariantOptionValue = z
  .object({
    name: z.string().meta({
      description: "The option this answers, as its Product names it — `Size`.",
    }),
    value: z.string().meta({
      description:
        "What this Variant is, for that option — `M`. Never empty, and never normalised: `M` and `Medium` are two different values because a Merchant said two different things.",
    }),
  })
  .openapi("VariantOptionValue");

export const Variant = z
  .object({
    id: z.uuid(),
    sku: z.string(),
    fulfilment: VariantFulfilment,
    options: z.array(VariantOptionValue).readonly().meta({
      description:
        "This Variant's value for each option its Product declares, **in the Product's own option order** — so a storefront zips the two lists to map a chosen combination to a SKU. Empty for a Product that declares no options, which is the ordinary Product. Short of the Product's list only where an option was declared after this Variant was written; correcting the Variant is what ends that.",
    }),
    media: z.array(Media).readonly().meta({
      description:
        "The Media attached to **this Variant**, in the order a Merchant set — so a storefront told that Red was picked can swap the picture for the red one. Empty unless somebody attached one, which is the ordinary Variant: its Product's images are what a page shows then, and this list deliberately does not fall back to them. Set the whole list with `PATCH /admin/variants/{id}`.",
    }),
    metadata: Metadata,
    prices: z.array(Price).readonly().meta({
      description:
        "Every Price set on this Variant. A Price is a row, so there may be several.",
    }),
    // A union rather than `Inventory.nullable()`, for `Store.defaultRegion`'s reason: written
    // the other way, **`Inventory`** is what is published as `object | null`, everywhere it
    // appears. It was, until #309.
    inventory: z.union([Inventory, z.null()]).meta({
      description:
        "What the Store has of this Variant, or `null` when nobody is counting it. Untracked is not the same as none left: an untracked Variant sells freely.",
    }),
  })
  .openapi("Variant");

/**
 * What a Merchant wrote about a Product, or `null` where nobody has written anything.
 *
 * **Nullable rather than optional**, so the field is always there and a client reads one
 * answer to "is there copy for this" rather than two. `null` and `""` are different facts —
 * a Product waiting for its copy against one deliberately described as nothing — and only
 * the first is what a Product created without a description holds.
 *
 * **Shared by {@link Product} and {@link StoreProduct}, which the shapes around it are
 * deliberately not.** What that split rules out is a shared *object* designed to grow, where
 * a field added for a Merchant is published to every publishable key by the next deploy. A
 * leaf cannot grow a field, {@link Metadata} is already shared by both for that reason, and
 * each surface still names this one itself — which is where the decision to publish it was
 * taken.
 */
export const ProductDescription = z.string().nullable().meta({
  description:
    "What this Product says for itself, in a Merchant's own words, or `null` where none has been written. Never an empty string: a Product nobody has written copy for has no description rather than a blank one.",
});

/**
 * The address a Product is known by — `blue-poster`, so a storefront's URL can be
 * `/products/blue-poster`.
 *
 * **Always present and never empty.** Unlike the description above there is no state of having
 * none: a create that names no handle is given one proposed from its title, and no route takes
 * one back off. So a client renders it without asking, which is the point of a `NOT NULL`
 * column reaching the wire as a required field.
 *
 * **Shared by {@link Product} and {@link StoreProduct} for {@link ProductDescription}'s
 * reason** — a leaf cannot grow a field, so sharing one costs nothing the split between those
 * two shapes is defending, and each surface still names this one itself.
 */
export const ProductHandle = z.string().meta({
  description:
    "The address this Product is known by, unique across the Store — `blue-poster`, so a storefront's URL can be `/products/blue-poster` rather than a UUID. `GET /store/products/{idOrHandle}` accepts it in place of the identifier.",
});

/**
 * Whether a Shopper may see this Product — and the field that is on the admin shapes and on
 * **neither** store shape.
 *
 * A **closed** set of three that partition the catalog, built from `catalog/status.ts`'s one
 * list rather than retyped here: a `draft` is being prepared and nobody outside the Admin can
 * see it, a `published` Product is what a storefront is served, and an `archived` one has left
 * the storefront without taking the Orders that reference it with it (ADR-0009). A client that
 * offers the filter can hold this as a union and be told by its compiler when a fourth arrives.
 *
 * **{@link StoreProduct} and {@link StoreProductDetail} do not carry it, and that is the field
 * #207's split was argued about.** `/store` is opened by a publishable key, so anything those
 * shapes carry is public — a `status` there would tell every browser which Products a Merchant
 * has not finished writing — and under ADR-0060 taking a field back out again is a major. What
 * a storefront gets instead is that the store reads answer `published` Products and nothing
 * else, enforced in the route rather than left to a filter: a client that could ask for drafts
 * is a client that will. That absence is asserted directly in `http/store.test.ts`, beside
 * `inventory` and `prices`, because a promise about what is *not* in a response is one nothing
 * else notices going missing.
 */
export const ProductStatus = z.enum(PRODUCT_STATUSES).openapi("ProductStatus");

/** As a list reports it: no Variants, because a list is not a detail view. */
export const Product = z
  .object({
    id: z.uuid(),
    title: z.string(),
    description: ProductDescription,
    handle: ProductHandle,
    status: ProductStatus,
    media: z.array(Media).readonly().meta({
      description:
        "The Media this Product shows, **in the order a Merchant put them in** — so the first one is the one that leads. On the list shape as well as on the detail, because a catalog grid is nothing but leading images and a client that had to open every Product to draw one would be making a request per tile. Attaching, reordering and detaching are all `media` on `PATCH /admin/products/{id}`; detaching removes the attachment and never the Media.",
    }),
    collections: z.array(Collection).readonly().meta({
      description:
        "The Collections this Product is in, **by title** — a set rather than an ordered list, so there is no position to report. Grouping and ungrouping are both `collections`, which takes the whole set: on `POST /admin/products`, so a Product can be created straight into one, and on `PATCH /admin/products/{id}` thereafter. Empty for a Product nobody has grouped, and `GET /admin/products?collection=` is the question asked the other way round.",
    }),
    metadata: Metadata,
  })
  .openapi("Product");

export const ProductDetail = Product.extend({
  options: z.array(ProductOption).readonly().meta({
    description:
      "The options a Shopper chooses this Product by — Size, Colour — **in the order the Merchant put them in**, because Size before Colour is a decision a storefront should not have to invent. Empty for a Product sold as one thing. On the detail shape and not on the list, which is not a detail view.",
  }),
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

/**
 * The Product list's query: ADR-0064's two parameters, and the one thing this list narrows by.
 *
 * A **constant**, like {@link CartPageQuery} and like every other schema on this surface —
 * `pageQuery` is a factory only because a list's name is what varies between its callers, and
 * there is one Merchant's Product list. What makes this the same contract as every other list's
 * is that it goes through {@link pageQueryOf}: a filter is added, and nothing about paging is
 * re-decided here.
 *
 * **`GET /store/products` must never grow the `status` half of this.** It is a different list
 * with a different name, and the only status it answers is `published`. It does take
 * {@link CollectionFilter}, which is why that one is written once and used twice.
 *
 * **The two compose**, because they are two optional parameters on one schema and two
 * `undefined`-droppable predicates in one `and`: a Merchant looking for the drafts in Summer
 * sends both.
 */
export const ProductPageQuery = pageQueryOf("products", {
  status: ProductStatus.optional().meta({
    description:
      "Narrow to the Products in one status — `draft` to find what is still being prepared, `published` for what is on sale, `archived` for what has been taken off it. The three partition the catalog, so omitting this answers all of them. A value that is not one of the three is **refused** rather than ignored, because a filter quietly dropped answers a different question from the one that was asked.",
  }),
  collection: CollectionFilter.meta({
    description:
      "Narrow to the Products in one Collection, by its `id`. Collections do **not** partition the catalog — a Product may be in several and most are in none — so this composes with `status` rather than replacing it, and omitting it answers the whole list. A value that names no Collection this Store has is **refused at 400** rather than answered with an empty page, because an empty page is a truthful-looking answer to a question nobody asked.",
  }),
});

/**
 * One Fulfilment Strategy this deployment has wired, by the name a Variant points at.
 *
 * **A name and nothing else**, and that is a limit of what a Strategy can be asked rather than
 * a field left for later. ADR-0014's three questions — does this ship, does it come off a
 * count, is there a Lead Time — are asked *of a Variant*, because a Strategy may read that
 * Variant's `metadata` to answer them. There is no Variant here, so there is no honest answer
 * to carry, and a Strategy that answered differently per Variant would be misreported by one.
 * They are on an Order's Fulfilments, where they are a snapshot of what was asked at Capture.
 *
 * An object rather than a bare string so that whatever a Strategy can one day say about itself
 * arrives as a field beside `name` — additive under ADR-0060 — instead of as a change to the
 * type of every element.
 */
export const FulfilmentStrategySummary = z
  .object({
    name: z.string().meta({
      description:
        "The name a Variant's `fulfilment.strategy` points at — Core's own `physical` and `digital`, and whatever key this deployment's `kobai.config.ts` wired beside them.",
    }),
  })
  .openapi("FulfilmentStrategySummary");

/**
 * Every Strategy this deployment has, and deliberately **not** a page of them (ADR-0067).
 *
 * No `limit`, no `after` and no {@link NextCursor}, which is the first of the two places
 * kobai's surface departs from ADR-0064's "every list route" — {@link Deployment} is the second
 * and arrived on the same argument. The reason is that this is not a list over a
 * table: the set is `Object.keys` of what `kobai.config.ts` wired, fixed at boot, with no rows,
 * no `created_at` to order by and nothing that can be inserted between one page and the next —
 * so the failure a cursor exists to prevent cannot happen here, and the cursor could not be
 * built from anything real if it did.
 */
export const FulfilmentStrategyList = z
  .object({
    strategies: z.array(FulfilmentStrategySummary).readonly().meta({
      description:
        "All of them, in name order. Never empty: Core's `physical` and `digital` are there unless a Project replaced them, and a Project that replaced one wired something under that name.",
    }),
  })
  .openapi("FulfilmentStrategyList");

export const CreateVariantRequest = z
  .object({
    sku: z.string(),
    fulfilment: VariantFulfilment.optional().meta({
      description:
        "The Fulfilment Strategy this Variant is delivered by. Defaults to `physical`. Naming one this deployment has not wired is refused: a Plugin's Strategy is wired in the Project's `kobai.config.ts`, and installing the Plugin does not do it.",
    }),
    options: z.array(VariantOptionValue).optional().meta({
      description:
        "This Variant's value for each option its Product declares, by the option's name. It must answer **every** one and **only** those: a value for an option the Product never declared, or a declared option left unanswered, is refused at 422 with `variant-options-mismatch`. It must also answer them in a way no other Variant of the same Product does, or it is refused at 409 with `variant-combination-taken` — a storefront maps the combination a Shopper chose to one Variant. Left out entirely is the same as an empty list, which is what a Product declaring no options wants.",
    }),
    metadata: Metadata.optional(),
  })
  .openapi("CreateVariantRequest");

/**
 * One option a create declares — a name, and its place in the list it arrived in.
 *
 * No identifier, because there is none yet: what a Variant of the same body answers by is the
 * **name**. No `position` either, for {@link ProductOption}'s reason — the array is the order.
 */
export const ProductOptionDeclaration = z
  .object({
    name: z.string().meta({
      description:
        "What this option is called — `Size`. Named twice in one list is refused.",
    }),
  })
  .openapi("ProductOptionDeclaration");

/**
 * One entry of a correction to a Product's options — which existing option it is, and what it
 * should now be called.
 *
 * **`id` present is identity and `id` absent is a new option.** A rename that dropped the
 * identifier would read as a removal and an addition, and would take every Variant's answer to
 * that option with it — which is the one thing a typo fix must not do.
 */
export const ProductOptionCorrection = z
  .object({
    id: z.uuid().optional().meta({
      description:
        "The option this entry **is**, as a read of this Product reported it. Left out, this is a new option — and every Variant already on the Product then leaves it unanswered until each one is corrected.",
    }),
    name: z.string().meta({ description: "What it should now be called." }),
  })
  .openapi("ProductOptionCorrection");

/**
 * A Product and the Variants that make it sellable, created together.
 *
 * `variants` is required and non-empty because a Product is never sellable in itself
 * (ADR-0008) — a Product with no options is not the exception, it is the ordinary case,
 * and it gets exactly one Variant like everything else.
 *
 * **There is no `status` here, and that is the decision** (story 6). What this route creates is
 * a **draft**, always; publishing is an act a Merchant performs at `PATCH /admin/products/{id}`
 * rather than a side effect of typing a title. A `status` on this body would make the two the
 * same request again, with the draft as whatever a client remembered to send.
 *
 * **`collections` *is* here, and `media` is still not** (#280). The two absences read alike and
 * are not the same: Media is bytes uploaded at a route of their own, so attaching is a second
 * act however this body is shaped, while a Collection is a row that already exists and grouping
 * a Product into one at the moment it is created costs nothing but the field. What it buys is
 * the request a client no longer makes twice — a hundred Products into a Collection was two
 * hundred requests. It is the same set {@link UpdateProductRequest} takes, refused in the same
 * words, so what may be created is what may be corrected to (ADR-0060).
 */
export const CreateProductRequest = z
  .object({
    title: z.string(),
    description: z.string().optional().meta({
      description:
        "What this Product says for itself, in a Merchant's own words. Left out, the Product has no description — `null` rather than an empty string, because a Product nobody has written copy for is a different thing from one described as nothing at all. Correct it later with `PATCH /admin/products/{id}`.",
    }),
    handle: z.string().optional().meta({
      description:
        'The address this Product is to be known by — lower-case letters and digits in groups separated by single hyphens, e.g. "blue-poster". **Left out, kobai proposes one from the title**, so a Merchant need not invent one for every Product. Either way a handle another Product already answers to is refused at 409 rather than quietly suffixed, and one that reads as a UUID is refused at 400: `GET /store/products/{idOrHandle}` resolves a UUID as an identifier, so a Product whose handle were one could not be reached by it.',
    }),
    options: z.array(ProductOptionDeclaration).optional().meta({
      description:
        "The options this Product is chosen by — Size, Colour — **in the order a storefront should offer them**. Declared here rather than at a route of their own, so a Variant naming an option its Product has not declared is not a state that exists for an instant: the options, the Variants and their values are written in one transaction. Left out, the Product is sold as one thing and its Variants carry no values — which is the one case two of them may answer nothing alike, since a Product declaring no options offers no combination to choose. Where it declares any, two Variants of this body answering them the same way is refused at 400: a storefront maps a combination to one Variant.",
    }),
    collections: z.array(CollectionMembership).optional().meta({
      description:
        "**The Collections this Product is created into** — the whole set, exactly as `PATCH /admin/products/{id}` takes it, so grouping a Product at the moment it is created is one request rather than two. Left out is the same as an empty list: a Product in no Collection, which is what every Product is until somebody groups it. The order carries no meaning — this is a set, not an ordered list like `media` on the correction — so what comes back is by title. A Collection this Store does not have is refused at 422 with `collection-not-found`, and **nothing is written**: no Product, no Variant and no membership. Nothing here creates a Collection; `POST /admin/collections` does.",
    }),
    metadata: Metadata.optional(),
    variants: z.array(CreateVariantRequest).min(1),
  })
  .openapi("CreateProductRequest");

/**
 * What a Merchant may change on a Product that already exists — and, by its absence, what they
 * may not.
 *
 * The same `PATCH` {@link UpdateVariantRequest} is and for the same reasons: **every field is
 * optional and each one absent means "leave it"**, and a named `metadata` **replaces** what is
 * stored rather than merging into it, because a merge leaves no way to take a key back out. A
 * body naming neither is refused rather than answered with the row unchanged.
 *
 * **There are no `variants` here, and that is the decision.** A Product's Variants are not a
 * field of it — one is added with `POST /admin/products/{id}/variants`, corrected with
 * `PATCH /admin/variants/{id}` and removed with `DELETE /admin/variants/{id}` — so a list here
 * would be a fourth way to say the same three things, and the only one that could silently
 * delete the Variant a caller left out of it.
 */
export const UpdateProductRequest = z
  .object({
    title: z.string().optional().meta({
      description:
        "A new title for this Product. Free to change: an Order's Line Items snapshot the title they were bought under (ADR-0009), so nothing already sold is rewritten. Two Products may share a title — it is what a Product is called, not what identifies it.",
    }),
    description: z.string().nullable().optional().meta({
      description:
        "New copy for this Product, or `null` to take what is there back off — which is the state a Product created without one is already in. Absent leaves whatever is stored, exactly as every other field here does.",
    }),
    handle: z.string().optional().meta({
      description:
        "A new address for this Product — the storefront URL it is reached at moves with it, so anything already linking to the old one stops resolving. There is no `null` here as there is for the description: a Product with no address is not a state that exists. One another Product answers to is refused at 409.",
    }),
    status: ProductStatus.optional().meta({
      description:
        "**Where a Product is published and where it is archived.** `published` puts it on the storefront, `archived` takes it off without touching the Orders that reference it — an Order's Line Items are a snapshot (ADR-0009) — and `draft` puts it back into preparation. There is no `null`: a Product with no status is not a state kobai has.",
    }),
    media: z.array(MediaAttachment).optional().meta({
      description:
        "**The complete list of the Media this Product shows, in the order it should be shown in** — so this is where an image is attached, where they are reordered, and where one is detached. An empty list detaches everything. **Detaching does not delete the Media**: it stays in this Store's library, may still be showing on another Product, and can be attached again — kobai deletes no asset and no bytes, ever. A Media this Store does not have is refused at 422 with `media-not-found`.",
    }),
    options: z.array(ProductOptionCorrection).optional().meta({
      description:
        "**The complete list of this Product's options, in the order it should end up in** — so this is where one is renamed, where they are reordered, where one is added and where one is removed. An entry carrying an `id` is the option that already has it, and its Variants' values stay attached to it; one without is new; one this Product has that the list does not name is removed, taking every Variant's value for it with it. An `id` naming no option of this Product is refused at 400. **Adding an option leaves every Variant already on the Product with it unanswered**, which `PATCH /admin/variants/{id}` is how each one is given a value for. **Removing one is refused at 409 with `variant-combination-taken` where it would leave two Variants answering one combination**, naming the two: correct or delete either of them and send this correction again.",
    }),
    collections: z.array(CollectionMembership).optional().meta({
      description:
        "**The complete set of the Collections this Product is in** — so this is where it is put into one and where it is taken out of one. An empty list takes it out of every Collection. A Product may be in as many as a Merchant likes, and the order carries no meaning: this is a set, not an ordered list like `media` beside it, so what a read answers with is by title. **Nothing here deletes a Collection**, and deleting one takes its Products out of it rather than deleting them. A Collection this Store does not have is refused at 422 with `collection-not-found`.",
    }),
    metadata: Metadata.optional().meta({
      description: "Replaces what is stored rather than merging into it.",
    }),
  })
  .openapi("UpdateProductRequest");

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
    media: z.array(MediaAttachment).optional().meta({
      description:
        "**The complete list of the Media this Variant shows, in the order it should be shown in** — the picture a storefront swaps to when a Shopper picks this size or colour. An empty list detaches everything, and detaching never deletes the Media: it stays in the Store's library and may still be showing elsewhere. It does not extend its Product's list and is not extended by it — a storefront has both and decides. Absent leaves what is attached, as every field here does.",
    }),
    options: z.array(VariantOptionValue).optional().meta({
      description:
        "This Variant's value for each option its Product declares, **replacing** every value it holds rather than merging into them — the rule `metadata` follows, for the reason it follows it. Named, it must answer every declared option and only those, or it is refused at 422 with `variant-options-mismatch`, and it must not answer them the way another Variant of the same Product does, or it is refused at 409 with `variant-combination-taken` — sending back the combination this Variant already answers is not that, since a Variant is not its own sibling. Absent leaves what is stored, so a Variant left unanswered by an option added since is still free to have its SKU corrected.",
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
    currency: z.string().optional().meta({
      description:
        "ISO 4217, read case-insensitively. **Any currency this Store has enabled** — `GET /admin/store` lists them — and one it has not is refused with `unsupported-currency`, because kobai converts nothing. Defaults to the Store's default currency, which is what a Price that named none has always been denominated in; it is deliberately not the named Region's currency, so this field means one thing whatever else the body carries.",
    }),
    regionId: z.uuid().optional().meta({
      description:
        "The `id` of the Region this Price applies to — `GET /admin/regions` lists them. **Left out is every Region**, which is what every Price written before Regions existed is, and it is the fallback a Region-constrained Price beats. One this Store has not got is refused with `region-not-found`. A Price denominated in a currency this Region does not select is accepted and can never win: it is the Region that decides the currency (ADR-0074).",
    }),
    channelId: z.uuid().optional().meta({
      description:
        "The `id` of the Channel this Price applies to — `GET /admin/channels` lists them. **Left out is every Channel.** Which Channel a request is in is decided by its API key, so this is how a marketplace listing is priced apart from a storefront without either of them asking for it (ADR-0020).",
    }),
    metadata: Metadata.optional(),
  })
  .openapi("SetPriceRequest");

/**
 * Which Region a price is resolved for — the one parameter both price routes take (#292).
 *
 * **Absent is the Store's default Region**, which is what keeps this additive under ADR-0060: a
 * storefront written before this parameter existed sends nothing and is answered exactly as it
 * was. A Region this Store has not got is refused at **400** rather than defaulted, so a
 * storefront interpolating the wrong variable finds out (story 15).
 *
 * **It is not a filter**, though it is the third query parameter on this surface that is neither
 * `limit` nor `after`: it decides *what the answer is* rather than *which rows are answered*, so
 * `http/filtering.test.ts` names it as the one kind of query parameter its sweep is not about.
 */
export const PriceQuery = z.object({
  region: z
    .string()
    .optional()
    .meta({
      param: { name: "region", in: "query" },
      description:
        "The `id` of the Region to price for — currency, and later tax and shipping, all follow from it. Absent is this Store's default Region, which is seeded at its first boot. One this Store has not got is refused at 400 rather than silently defaulted.",
    }),
});

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
  "handle-taken": "handle-taken",
  "last-variant": "last-variant",
  "stock-is-reserved": "stock-is-reserved",
  "unsupported-currency": "unsupported-currency",
  "unknown-fulfilment-strategy": "unknown-fulfilment-strategy",
  "variant-options-mismatch": "variant-options-mismatch",
  // The one word #277 added, and the only one on this surface that is a fact about a Variant's
  // **siblings**: two Variants of one Product answering its options the same way is a detail
  // payload a storefront cannot map a chosen combination through. It is one word at the two
  // routes that write a Variant into a Product that already exists and at the Product's own
  // correction, because it is one fact reached from three ends — a create names it twice in its
  // own body instead, which is `invalid`, exactly as two Variants of one body naming one SKU is.
  "variant-combination-taken": "variant-combination-taken",
  // The one word #255 added, and it is `GET /media/{key}`'s own said about the same fact from
  // the other end: `media` names an asset this Store has none of. One fact gets one word
  // (ADR-0060) — which is also why {@link MediaNotFound} carries it as a literal rather than as
  // a family of its own.
  "media-not-found": "media-not-found",
  // The one word #256 added, and it is `GET /admin/collections/{id}`'s own said about the same
  // fact from the other end: `collections` names a Collection this Store has none of. One fact
  // gets one word — which is also why {@link CollectionRefusal} carries it rather than a second
  // spelling of its own.
  "collection-not-found": "collection-not-found",
  // The two words #292 added, and the same argument a third and a fourth time: a Price names a
  // Region or a Channel this Store has none of, which is the fact `GET /admin/regions/{id}` and
  // `GET /admin/channels/{id}` already answer 404 with. One fact gets one word, and they arrive
  // here at 422 for `collection-not-found`'s reason — the body is well formed and what refuses
  // it is the state of the Store.
  "region-not-found": "region-not-found",
  "channel-not-found": "channel-not-found",
} as const satisfies {
  [R in
    | Refused<ProductCreation>
    | Refused<VariantCreation>
    | Refused<ProductUpdate>
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

// ---- The catalog, as a storefront sees it ----------------------------------------------

/**
 * The store surface's own catalog shapes, and the reason there are four of them rather than a
 * reuse of the four above.
 *
 * **This is the load-bearing decision of the store catalog.** {@link Product},
 * {@link ProductDetail} and {@link Variant} are what a *Merchant* is shown, behind a session and
 * a `catalog:read` Permission. A publishable key is shipped to a browser, so anything these
 * schemas carry is public — and under ADR-0060 a field added here is promised, while taking one
 * back out is a major. Reusing the admin shapes would make every future field a Merchant needs
 * public on the deploy that adds it, with a review as the only thing in the way; declaring them
 * apart makes publishing a field an edit somebody made in this section, deliberately.
 *
 * The two `metadata` bags are the same escape hatch (ADR-0004) and are kept for that reason: a
 * Project's description, imagery and copy live there until catalog breadth models them, and a
 * product page with only a title is not a product page. What is dropped, and why, is beside
 * each field and in `catalog/store-read.ts`.
 */
export const StoreVariantFulfilment = z
  .object({
    strategy: z.string().meta({
      description:
        "The Fulfilment Strategy this Variant is delivered by, by name — `physical`, `digital`, or whatever this deployment wired. A storefront reads it to know that a download is a download; what the Strategy *answers* about shipping, stock and Lead Time is not published here, and is snapshotted onto an Order's Fulfilments at Capture.",
    }),
  })
  .openapi("StoreVariantFulfilment");

/**
 * One image, as a storefront sees it — where it is, what it shows, and how big it is.
 *
 * **Declared apart from {@link Media}, and what it drops is everything about the *file*.**
 * `filename` is the name the image had on a Merchant's own machine, and `contentType` and
 * `byteSize` are facts the thing fetching the bytes is told by the response that carries them —
 * so publishing any of the three would be promising a browser something about an object a CDN
 * in front is free to change, and under ADR-0060 taking a field back out again is a major. What
 * is left is what a page lays out with.
 *
 * `url` is still the deployment's `MediaStorage`'s own answer, asked at read time and never
 * stored (ADR-0078): absolute for a Store on a CDN, root-relative for the storage kobai ships,
 * and a storefront renders both without parsing either.
 */
export const StoreMedia = z
  .object({
    id: z.uuid(),
    url: z.string().meta({
      description:
        "Where the bytes are. Absolute for a deployment whose `MediaStorage` has an address of its own, and root-relative (`/media/…`) for the storage kobai ships. Render it; parse none of it.",
    }),
    alt: z.string().nullable().meta({
      description:
        "What this shows, for a Shopper who cannot see it — or `null` where nobody has written it. Never an empty string: that is what a *decorative* image says, which is a different fact from nobody having been asked. A storefront falling back to an empty `alt` is telling a screen reader the image is decoration, which for an undescribed one is the honest of the two answers available to it.",
    }),
    width: z.int().nullable().meta({
      description:
        "The image's own width in pixels, or `null` where kobai could not read the format's header. `null` rather than `0`, so a page reserves space only when it really knows how much.",
    }),
    height: z.int().nullable().meta({ description: "Likewise, in pixels, or `null`." }),
  })
  .openapi("StoreMedia");

/**
 * One option a Product is chosen by, as a storefront sees it — the name, and no identifier.
 *
 * **Declared apart from {@link ProductOption}, and the `id` is what it drops.** A storefront
 * addresses nothing by an option's identifier: it zips the Product's options against each
 * Variant's values, both keyed by **name**, which is unique within a Product. The identifier
 * exists so that `PATCH /admin/products/{id}` can rename an option without losing its values,
 * which is a Merchant's problem and not a Shopper's — and under ADR-0060 a field published here
 * could not be taken back out without a major.
 */
export const StoreProductOption = z
  .object({
    name: z.string().meta({
      description:
        "What this option is called — `Size`, `Colour`. Unique within the Product, and what each Variant's values are keyed by.",
    }),
  })
  .openapi("StoreProductOption");

/**
 * One Collection a Product is in, as a storefront sees it (#256, story 18).
 *
 * The same three fields {@link Collection} carries, and deliberately a schema of its own for
 * {@link StoreVariantFulfilment}'s reason: two schemas that happen to agree is the cheap half of
 * #207's split, and one schema two surfaces share is the expensive half, arriving later and as a
 * major. The `id` is published because it is what `?collection=` takes — a storefront listing a
 * Collection sends back the identifier the Product it was looking at reported.
 *
 * **Nothing on this surface enumerates Collections**, deliberately: a storefront's navigation is
 * built from what the Products it read are in, and a `GET /store/collections` is additive under
 * ADR-0060 the day something needs one.
 */
export const StoreCollection = z
  .object({
    id: z.uuid().meta({
      description:
        "What `GET /store/products?collection=` takes, to list this Collection.",
    }),
    title: z.string().meta({
      description: "What the Merchant calls it. Not unique across the Store.",
    }),
    metadata: Metadata,
  })
  .openapi("StoreCollection");

/**
 * A Variant's value for one option, as a storefront sees it.
 *
 * The same two fields {@link VariantOptionValue} carries, and deliberately a schema of its own
 * for {@link StoreVariantFulfilment}'s reason: two schemas that happen to agree is the cheap
 * half of #207's split, and one schema two surfaces share is the expensive half, arriving later
 * and as a major.
 */
export const StoreVariantOptionValue = z
  .object({
    name: z.string().meta({
      description: "The option this answers, as its Product names it — `Size`.",
    }),
    value: z
      .string()
      .meta({ description: "What this Variant is, for that option — `M`." }),
  })
  .openapi("StoreVariantOptionValue");

/**
 * A Variant as a storefront sees it: no count, and no Prices.
 *
 * **`fulfilment` is {@link StoreVariantFulfilment} and deliberately not {@link
 * VariantFulfilment}**, though the two carry the same one field today — and `options` is
 * {@link StoreVariantOptionValue} rather than {@link VariantOptionValue} for exactly the same
 * reason, though those two agree field for field. Referencing the admin schema would have
 * reopened the hole this whole section closes from the inside: both are objects designed to
 * grow — "so that the next thing a Variant needs to say about how it is fulfilled arrives beside
 * this one" — and a field added to the shared one for a Merchant would be published to every
 * publishable key on the next deploy, which is the failure the split exists to prevent. Two
 * schemas that happen to agree is the cheap half of the decision; one schema two surfaces share
 * is the expensive half, arriving later and as a major.
 */
export const StoreVariant = z
  .object({
    id: z.uuid(),
    sku: z.string(),
    fulfilment: StoreVariantFulfilment,
    options: z.array(StoreVariantOptionValue).readonly().meta({
      description:
        "What this Variant is, for each option its Product declares, **in the Product's option order** — the storefront's half of the pair that makes a picker possible.",
    }),
    media: z.array(StoreMedia).readonly().meta({
      description:
        "The images of **this** Variant, in the Merchant's own order — so a page told that Red was picked can show the red one. Empty unless somebody attached one, which is the ordinary Variant; it deliberately does not fall back to the Product's list, so a storefront with both in front of it decides whether picking a colour replaces the gallery or adds to it.",
    }),
    metadata: Metadata,
  })
  .openapi("StoreVariant");

/** As a list reports it: no Variants, because a list is not a detail view. */
export const StoreProduct = z
  .object({
    id: z.uuid(),
    title: z.string(),
    /**
     * **Published deliberately, and it is the one admin field this section adds by hand.**
     * A description is copy a Merchant writes *for a Shopper to read*, so a storefront that
     * could not read it would be missing the thing it was written for — which is why the
     * schema names it here rather than inheriting it from {@link Product}, exactly as this
     * section's whole argument requires: a field is public because somebody said so here.
     */
    description: ProductDescription,
    /**
     * **Published because it is the only reason this column exists.** A handle is an address a
     * storefront builds its own URL out of, so a `/store` shape that dropped it would leave
     * every storefront back on the UUID — and this is the route that reads one back.
     */
    handle: ProductHandle,
    /**
     * **Published deliberately, and as a shape of its own.** A product page with no picture is
     * not a product page, and a catalog grid is nothing but leading images — so the list is on
     * this shape as well as on the detail, in the Merchant's own order, with the first one
     * leading. {@link StoreMedia} is where the decision about *which fields* is taken.
     */
    media: z.array(StoreMedia).readonly().meta({
      description:
        "The images this Product shows, **in the order a Merchant put them in** — the first one leads. On the list shape as well as on the detail, so a catalog grid is one request rather than one per tile. Empty for a Product nobody has attached an image to.",
    }),
    /**
     * **Published deliberately, so a storefront renders breadcrumbs without a second request**
     * (#256, story 18). A page browsing a Collection has to say what it is browsing and offer
     * the way back out; a product page has to say where it sits. Both are questions about *this*
     * Product, so the answer travels with it.
     */
    collections: z.array(StoreCollection).readonly().meta({
      description:
        "The Collections this Product is in, by title — so a page can render breadcrumbs, or link a catalog tile at the Collection it belongs to, without a second request. A **set**: a Product may be in several and most are in none, and the order carries no meaning. Send an `id` back as `?collection=` to list that Collection; nothing on this surface enumerates them.",
    }),
    metadata: Metadata,
  })
  .openapi("StoreProduct");

/**
 * A Product opened, with the Variants a Shopper chooses between.
 *
 * Inline rather than a second request per Variant: rendering a product page is the one place a
 * storefront needs them all, and N+1 requests over a public API is a page that renders slowly
 * for everyone and expensively for the Store.
 */
export const StoreProductDetail = StoreProduct.extend({
  options: z.array(StoreProductOption).readonly().meta({
    description:
      "The options a Shopper chooses this Product by — Size, Colour — **in the order the Merchant put them in**, which is the order a picker should offer them in. Together with each Variant's `options` this is everything a storefront needs to map a chosen combination to a SKU **client-side**: a combination no Variant answers is simply absent, which is what makes it unavailable rather than an error. There is deliberately no route that takes a combination and answers a Variant.",
  }),
  variants: z.array(StoreVariant).readonly(),
}).openapi("StoreProductDetail");

/**
 * How a storefront addresses a Product: its identifier, or its handle.
 *
 * **A plain string, for {@link IdParam}'s reason and one more.** Anything that is neither is a
 * 404 rather than a 400 — a handle nothing answers to and an identifier nothing carries are the
 * same answer to the caller. And there is nothing narrower to declare that would be true: the
 * parameter's whole point is that two spaces of string are accepted here, so a schema saying
 * which would have to say `uuid` or *the shape a handle happens to have today*, and the second
 * is a rule `catalog/handle.ts` may relax.
 *
 * **Named `idOrHandle` rather than `id`**, so a Developer reads what the route does off the
 * description instead of finding out that a handle works. Renaming a path parameter is a break
 * under ADR-0060 and free under ADR-0058's licence until the first publish, which is why it
 * happens now rather than later.
 */
export const IdOrHandleParam = z.object({
  idOrHandle: z.string().meta({
    description:
      "A Product's identifier, or its handle. A UUID is read as an identifier and anything else as a handle; neither being found is the same 404.",
  }),
});

/** The list, in an envelope — the same shape, and the same reason, as {@link ProductList}. */
export const StoreProductList = z
  .object({ products: z.array(StoreProduct).readonly(), nextCursor: NextCursor })
  .openapi("StoreProductList");

/**
 * The store Product list's query: ADR-0064's two parameters, and the one thing it narrows by.
 *
 * A **constant**, like every other schema on this surface, and built by {@link pageQueryOf} so
 * that a filter is added and nothing about paging is re-decided (#183).
 *
 * **`?collection=` is the only filter this list will ever take from a client, and `?status=` is
 * the one it must never grow.** Which Products a storefront may see is enforced in the route —
 * `published` and nothing else — because a client that could ask for drafts is a client that
 * will. Narrowing to a Collection is a Shopper *browsing* (story 18) rather than a client
 * choosing what is visible, which is why the two are not the same kind of parameter at all.
 */
export const StoreProductPageQuery = pageQueryOf("store-products", {
  collection: CollectionFilter.meta({
    description:
      "Narrow to the published Products of one Collection, by the `id` each Product's own `collections` reports — this is how a storefront browses one. It composes with the page rather than replacing it, so a short page is still not the end of the list. `published` is not negotiable here: a draft in this Collection is answered by neither the filtered list nor the whole one. A value that names no Collection this Store has is **refused at 400** rather than answered with an empty page.",
  }),
});

/**
 * Reading a Product or a Variant that is not there.
 *
 * Two words, and **not** {@link CatalogRefusal}'s two of the same spelling. That set is ten
 * reasons wide because it covers nine admin routes, and a storefront branching on it would be
 * handed `sku-taken` and `last-variant` as things a catalog read might answer — which it never
 * can. Each module owns its own vocabulary (ADR-0060), and the mapped `satisfies` below is what
 * holds this one to exactly what `catalog/store-read.ts` can refuse: a rename there turns this
 * red naming the word, and a reason with no key does not compile.
 */
const STORE_CATALOG_REASONS = {
  "product-not-found": "product-not-found",
  "variant-not-found": "variant-not-found",
} as const satisfies { [R in StoreCatalogReason]: R };

export const StoreCatalogRefusal = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.enum(STORE_CATALOG_REASONS).meta({
      description: "Machine-readable. Branch on this.",
    }),
  })
  .openapi("StoreCatalogRefusal");

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
 * A resolved price, which market it was resolved for, and which Steps produced it.
 *
 * `workflow.steps` is part of the contract rather than a debugging nicety: it is what
 * lets a Developer who replaced a Step *see* that theirs ran (spec story 33).
 *
 * **`region` and `channel` say which question was answered** (#292). A storefront that sent no
 * `?region=` was answered for the Store's default and has no other way to learn which that was;
 * a Merchant previewing a price needs to know it is looking at Malaysia's. The Channel is the
 * one the presented API key is in, so this is also where a storefront finds out what its own
 * credential is bound to — `null` is the unconstrained Channel, and it is what
 * `GET /admin/variants/{id}/price` always answers, since a Merchant's session carries no key.
 */
export const ResolvedPrice = z
  .object({
    variant: VariantIdentity,
    region: RegionIdentity.meta({
      description:
        "The Region this price is for — what `?region=` named, or this Store's default where it named none.",
    }),
    channel: z.union([ChannelIdentity, z.null()]).meta({
      description:
        "The Channel the presented API key is in, or `null` for a key in no particular one — and always `null` on the admin preview, which presents a session rather than a key.",
    }),
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
    workflow: z
      .object({
        name: z.string(),
        failed: z.string().meta({ description: "The slot that refused." }),
        steps: z.array(StepReport).readonly(),
      })
      .optional()
      .meta({
        description:
          "How far the Workflow got. Absent when the request was turned back before it ran at all — which on the **store** surface is what a Variant whose Product is not published is refused by, since `resolve-price` prices a Variant and does not decide who may see one (#276). Branch on `reason` rather than on this.",
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
 * A Cart as the **Merchant's list** reports it — everything but what is in it.
 *
 * The split {@link Cart} makes with this is `OrderSummary`'s, for the same reason: a list is not
 * a detail view, and a Merchant scanning what is being held wants whose Cart it is, what has
 * become of it and when it lapses rather than every line of every Cart at once.
 */
export const CartSummary = z
  .object({
    id: z.uuid().meta({
      description:
        "The identifier, and the whole of the authority to act on this Cart — there is no Shopper session to hang one off (ADR-0020). Treat it as a credential: it is unguessable, and anyone holding it can change this Cart. A Merchant may enumerate these and the public may not (ADR-0071).",
    }),
    // A union rather than `CartShopper.nullable()`, for `Store.defaultRegion`'s reason: written
    // the other way, **`CartShopper`** is what is published as `object | null` — here and at
    // `OrderSummary`, which names the same component. It was, until #309.
    shopper: z.union([CartShopper, z.null()]).meta({
      description: "`null` for a guest, which is the ordinary path.",
    }),
    currency: z.string().meta({
      description:
        "ISO 4217 — the one currency this Cart is denominated in, and what every line of it is priced in. **Stamped when the Cart's Region was set rather than read through it** (ADR-0074), so a Merchant who moves a Region onto another currency does not reprice a Cart that already exists: where this and `region.currency` differ, this is the one that decides. It moves only when `PATCH /store/carts/{id}` moves the Cart to another Region.",
    }),
    // **A union rather than `RegionIdentity.nullable()`**, for `Store.defaultRegion`'s reason:
    // `.nullable()` at a *reference* site is applied to the registered component, so
    // `RegionIdentity` would be published as `object | null` and every other place that names
    // one — a Price, a resolved price — would promise a `null` no handler produces.
    region: z.union([RegionIdentity, z.null()]).meta({
      description:
        "Where this Cart is being bought — the Region its lines are priced in. `null` only for a Cart started before kobai recorded one, which is priced for the Store's default Region.",
    }),
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
  .openapi("CartSummary");

/**
 * A Cart, and what every route on it answers with — creating one, changing it, or reading it.
 *
 * **No totals.** ADR-0009 makes a Cart unauthoritative: what a Shopper pays is resolved at
 * Capture, and a figure here would be one nothing stands behind and the first thing anybody
 * would mistake for one.
 *
 * **What a Cart comes to is asked for, at {@link Quote}** — `POST /store/carts/{id}/quote`,
 * which runs this deployment's own pricing Steps and reports the instant it ran them
 * (ADR-0077). That is a different thing from a field here, and the rule above is what decides
 * it: an answer to a question carries a time and stands behind itself, and a number on this
 * shape would do neither.
 */
export const Cart = CartSummary.extend({
  lineItems: z.array(CartLineItem).readonly(),
}).openapi("Cart");

/** The list, in an envelope — the same shape, and the same reason, as `OrderList`. */
export const CartList = z
  .object({ carts: z.array(CartSummary).readonly(), nextCursor: NextCursor })
  .openapi("CartList");

/**
 * What has become of a Cart, and the one thing `GET /admin/carts` filters by (ADR-0071).
 *
 * The three **partition** the table rather than overlapping: a Cart that became an Order is
 * `spent` whatever its deadline says, one that has not and is past its deadline is `expired`,
 * and everything else is `live`. `live` is the useful one — it is the answer to *why is that
 * stock unavailable*, which is a Shopper away at their bank (ADR-0070) — and without the filter
 * the default list is mostly history.
 */
export const CartState = z.enum(["live", "expired", "spent"]).openapi("CartState");

/**
 * The Cart list's query: ADR-0064's two parameters, and the one thing this list narrows by.
 *
 * A **constant**, like every other schema on this surface — `pageQuery` is a factory only
 * because a list's name is what varies between its callers, and there is one Cart list. What
 * makes this the same contract as every other list's is that it is built by
 * {@link pageQueryOf}: a filter is added, and nothing about paging is re-decided here.
 */
export const CartPageQuery = pageQueryOf("carts", {
  state: CartState.optional().meta({
    description:
      "Narrow to Carts in one state. `live` is holding stock and can still be placed, `expired` ran out of time, and `spent` has already become an Order. The three partition the list, so omitting this answers all of them.",
  }),
});

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
    regionId: z.uuid().optional().meta({
      description:
        "The `id` of the Region this Cart is bought in — it decides what the Cart is denominated in and what its lines are priced at. **Left out is the Store's default Region**, so a storefront selling into one market never mentions a Region at all. One this Store has not got is refused with `region-not-found`. There is no `null`: a Cart is always bought somewhere.",
    }),
    metadata: Metadata.optional(),
  })
  .openapi("CreateCartRequest");

/** Name what should change; naming none of them is refused rather than treated as a no-op. */
export const UpdateCartRequest = z
  .object({
    shopper: AttachShopper.nullable().optional().meta({
      description:
        "Needs a secret key. `null` detaches the Shopper; absent leaves whoever is on the Cart alone.",
    }),
    regionId: z.uuid().optional().meta({
      description:
        "Move this Cart to another Region — **the same Cart, the same `id` and every Line Item on it**, re-denominated in the new Region's currency and re-priced there on the next read, because a Cart's lines carry no price snapshot (ADR-0009). Naming the Region it is already in changes nothing and is not refused, so a storefront may send the whole state it is holding. Refused with `cart-is-denominated` while this Cart is holding stock — a hold is claimed in the currency the Cart was in, and kobai serves no way to give one back by hand — and with `variant-not-priced-in-region`, naming them, where a line would have no Price in the new Region.",
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
  // The three a Region brought (#293). `region-not-found` is the admin surface's own word for
  // the same fact, because one fact gets one word whichever end asks it; the other two are this
  // surface's alone, and `cart/write.ts` is where each is argued.
  "region-not-found": "region-not-found",
  "cart-is-denominated": "cart-is-denominated",
  "variant-not-priced-in-region": "variant-not-priced-in-region",
} as const satisfies { [R in CartRefusalReason | RequestReason]: R };

export const CartRefusal = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.enum(CART_REASONS).meta({
      description: "Machine-readable. Branch on this.",
    }),
  })
  .openapi("CartRefusal");

// ---- Holding a Cart's stock -------------------------------------------------------------

/** One claim a Cart is holding, as the Reservation record keeps it. */
const HeldClaim = z
  .object({
    provider: z.string().meta({
      description:
        "Which kind of scarce thing this claims — `inventory` is the one Core has (ADR-0018).",
    }),
    subject: z.string().meta({
      description:
        "What is claimed, in that provider's own terms. For `inventory` it is the Variant's identifier.",
    }),
    quantity: z.int().meta({ description: "How much of it is held." }),
  })
  .openapi("HeldClaim");

/**
 * What a Cart is holding, and until when.
 *
 * **There are no Reservation identifiers here, deliberately.** A hold is given back by placing
 * the Order, by changing the Cart, or by lapsing — there is no route that releases one, and a
 * handle a storefront could quote at such a route would be the beginning of releasing a hold out
 * from under a Shopper who is mid-payment (ADR-0071).
 */
export const CartReservations = z
  .object({
    cartId: z.uuid(),
    reservations: z.array(HeldClaim).readonly().meta({
      description:
        "Empty for a Cart of Variants nothing is counting: a Store selling downloads holds nothing, and that is a 200 rather than a refusal (ADR-0014).",
    }),
    expiresAt: z.iso.datetime().optional().meta({
      description:
        "When this hold lapses and the units go back on the shelf. Absent when nothing is held, because then there is no deadline. Holding again does not push it out — how long a hold stands is the deployment's setting (ADR-0075), not a thing a caller can extend by asking twice.",
    }),
  })
  .openapi("CartReservations");

/**
 * Holding a Cart's stock, refused — a **closed** set, unlike `PlaceOrderRefusal`'s.
 *
 * Nothing a Project or a Plugin supplies runs on this path: no Workflow is invoked, so every
 * refusal is Core's own and a storefront can narrow on the lot. The keys are held to
 * `reservation/hold-cart.ts`'s union by the mapped `satisfies`, so a Reservation provider that
 * brings a new way of saying "the Store has not got it" turns this red naming the word rather
 * than answering it under some other one.
 */
const CART_RESERVATION_REASONS = {
  "cart-not-found": "cart-not-found",
  "cart-expired": "cart-expired",
  "cart-placed": "cart-placed",
  "cart-empty": "cart-empty",
  "variant-unavailable": "variant-unavailable",
  "unknown-fulfilment-strategy": "unknown-fulfilment-strategy",
  "insufficient-inventory": "insufficient-inventory",
} as const satisfies { [R in HoldCartRefusal]: R };

export const CartReservationRefusal = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.enum(CART_RESERVATION_REASONS).meta({
      description: "Machine-readable. Branch on this.",
    }),
  })
  .openapi("CartReservationRefusal");

// ---- Quoting a Cart ---------------------------------------------------------------------

/**
 * One Adjustment as a quote reports it — what an Order's would say, without the row's identity.
 *
 * `id` is absent because nothing was written: a quote runs the Steps that *decide* an Adjustment
 * and stops before the transaction that would give it one, so an identifier here would name a
 * record that does not exist. Everything else is what {@link OrderAdjustment} carries.
 */
export const QuoteAdjustment = z
  .object({
    code: z.string().meta({
      description:
        "Machine-readable, and chosen by the Step that added it — `lead-time-surcharge`, `loyalty-discount`. Core defines none of its own, so this is not a closed set.",
    }),
    description: z.string().meta({ description: "For a person to read." }),
    amount: z.int().meta({
      description:
        "**Signed** minor units: negative discounts, positive surcharges. The totals account for it either way.",
    }),
    metadata: Metadata,
  })
  .openapi("QuoteAdjustment");

/**
 * An Adjustment on the Cart as a whole, with the tax a Step worked out for it.
 *
 * The split {@link OrderLevelAdjustment} makes, for the same reason: a line's own Adjustments are
 * already inside that line's `tax`, because tax is charged on the adjusted line — so only the
 * ones belonging to no line carry a figure of their own.
 */
export const QuoteLevelAdjustment = QuoteAdjustment.extend({
  tax: z.int().meta({
    description:
      "Tax on this Adjustment, in minor units, signed with `amount`. Zero until a tax Step is wired.",
  }),
}).openapi("QuoteLevelAdjustment");

/**
 * One line of a Cart, priced as it would be charged now.
 *
 * It is **not** a snapshot and does not become one: `sku` is what the Variant is called at this
 * instant, and a Product renamed a second later is renamed here too. That is the whole difference
 * between this and {@link OrderLineItem}, which froze its copy at Capture (ADR-0009).
 */
export const QuoteLineItem = z
  .object({
    lineItemId: z.uuid().meta({
      description:
        "The **Cart's** Line Item this prices. Named rather than `id` because nothing was created: there is no Order here and no Line Item of one.",
    }),
    variantId: z.uuid(),
    sku: z.string().meta({ description: "The Variant's SKU **now**, not a snapshot." }),
    quantity: z.int(),
    unitAmount: z.int().meta({
      description:
        "What one of it costs, in minor units — resolved through this deployment's `resolve-price`, exactly as placing would resolve it.",
    }),
    tax: z.int().meta({
      description:
        "Tax on this line, in minor units. Zero until a tax Step is wired, the way an Order's is.",
    }),
    adjustments: z.array(QuoteAdjustment).readonly().meta({
      description:
        "The discounts and surcharges on this line, in the order they were applied. `unitAmount` above is untouched by them; `total` below accounts for all of them.",
    }),
    total: z.int().meta({
      description:
        "What this line comes to: `unitAmount` × `quantity`, plus its Adjustments, plus `tax`.",
    }),
  })
  .openapi("QuoteLineItem");

/**
 * **What a Cart comes to, as at one instant** (ADR-0077).
 *
 * The figure a storefront needs before it starts a payment the Shopper completes somewhere else:
 * the payment has to be created for an amount, and until this route existed the only figure
 * available was the storefront's own arithmetic over prices it had read (ADR-0070).
 *
 * **It is a quote and not a promise, and three things say so.** `quotedAt` is when it was worked
 * out; there is no deadline on it, because a quote that expired would be one that was good until
 * it did; and there is nothing here to quote back at kobai — no handle, no identifier, no token
 * `POST /store/orders` would accept. Prices, Adjustments and tax may all move between this call
 * and a placement, and what is charged is what the placement works out. What it *does* guarantee
 * is that both figures come from the same declaration: this runs this deployment's own
 * `place-order` Steps as far as the tax, so a Project that replaced a pricing Step quotes the
 * prices it will charge.
 *
 * **Nothing is held, charged or written.** Stock is held by
 * `POST /store/carts/{id}/reservations`, and asking this question claims nothing — so a Cart
 * quoted and then placed can still be refused `insufficient-inventory`.
 */
export const Quote = z
  .object({
    cartId: z.uuid(),
    currency: z.string().meta({ description: "ISO 4217. Every amount here is in it." }),
    lineItems: z.array(QuoteLineItem).readonly().meta({
      description:
        "In the Cart's own order — the order `GET /store/carts/{id}` reports its lines in, and **not** the SKU order an Order reports Line Items in. Read a line by its `sku` rather than by position if you are comparing the two.",
    }),
    adjustments: z.array(QuoteLevelAdjustment).readonly().meta({
      description:
        "The Adjustments belonging to no single line — a basket-wide voucher, a delivery surcharge. A line's own are on the line. These are the ones that carry a `tax` of their own.",
    }),
    total: z.int().meta({
      description:
        "What the whole Cart comes to, in minor units: every line total, plus these Adjustments and the tax on each of them. This is the figure a placement of this Cart, unchanged, would charge.",
    }),
    quotedAt: z.iso.datetime().meta({
      description:
        "When this was worked out. Nothing is bound to it and nothing expires with it — it is here so the answer reads as a moment rather than as an offer.",
    }),
    workflow: z.object({
      name: z.string(),
      steps: z.array(StepReport).readonly().meta({
        description:
          "The Steps that produced this, in order — the pricing half of `place-order`, stopping before the Step that claims stock. A Project that replaced one sees its own here.",
      }),
    }),
  })
  .openapi("Quote");

export const QuoteRequest = z
  .object({
    // No `.meta()` here: this field emits a `$ref`, and a description on it would replace
    // `OpenMetadata`'s own rather than sit beside it. The schema says the whole thing.
    metadata: OpenMetadata.optional(),
  })
  .openapi("QuoteRequest");

/**
 * The ways this route turns a body back before the Workflow runs, as a **closed set**.
 *
 * Its own schema rather than a share of {@link PlaceOrderRequestRefusal}, although the words are
 * the same three: that one is named for the route that places an Order, and a client reading a
 * description should not have to work out that a schema named after one route governs another.
 * The reasons are identical because the open context is — both halves, and a key in both refused
 * rather than resolved (#121).
 */
export const QuoteRequestRefusal = z
  .object({
    error: z.string().meta({ description: "What went wrong, in prose." }),
    reason: z.enum({ ...REQUEST_REASONS, "metadata-in-both": "metadata-in-both" }),
  })
  .openapi("QuoteRequestRefusal");

/**
 * Every reason of Core's own a quote can be refused with — two unions, and it takes both.
 *
 * Reading the Cart makes the first, exactly as it does for a placement and for a hold, so a word
 * added to `load-cart.ts` turns this red along with both of those. `resolve-price`'s travel out
 * of `price-lines` as themselves, which is what makes a Plugin's or a Project's pricing Step able
 * to refuse a quote in its own words.
 *
 * What is **not** here is everything the pricing half never reaches: no payment is asked for and
 * nothing is claimed, so `payment-declined`, `no-payment-provider` and `insufficient-inventory`
 * are not among the answers this route has.
 */
const QUOTE_REASONS = {
  "cart-not-found": "cart-not-found",
  "cart-expired": "cart-expired",
  "cart-placed": "cart-placed",
  "cart-empty": "cart-empty",
  "variant-unavailable": "variant-unavailable",
  "unknown-fulfilment-strategy": "unknown-fulfilment-strategy",
  "variant-not-found": "variant-not-found",
  "price-not-set": "price-not-set",
} as const satisfies { [R in QuoteCartReason | PriceResolutionRefusal]: R };

/**
 * A Workflow declining to quote a Cart, and how far it got.
 *
 * `reason` is an open string for {@link PlaceOrderRefusal}'s reason: the pricing Steps are the
 * ones a Project is most likely to have replaced, and a Step this build of Core has never heard
 * of refuses with whatever it likes. Core answers 422 for a reason it does not know.
 *
 * `workflow` is not optional here, unlike a placement's: nothing turns a quote back between the
 * request being read and the Workflow starting, because there is no idempotency key to claim.
 */
export const QuoteRefusal = z
  .object({
    error: z.string(),
    reason: stepReason(QUOTE_REASONS),
    workflow: z.object({
      name: z.string(),
      failed: z.string().meta({ description: "The slot that refused." }),
      steps: z.array(StepReport).readonly(),
    }),
  })
  .openapi("QuoteRefusal");

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
    // A union, for `Store.defaultRegion`'s reason — and `.nullable()` at *either* of the two
    // sites naming `CartShopper` would have published it as `object | null` at both.
    shopper: z.union([CartShopper, z.null()]).meta({
      description: "As at Capture. `null` for a guest, which is the ordinary path.",
    }),
    currency: z.string().meta({ description: "ISO 4217. Every amount here is in it." }),
    total: z.int().meta({
      description:
        "What was charged, in minor units — every Line Item's total, plus the Order's own Adjustments and the tax on each of them.",
    }),
    // A union, for `Store.defaultRegion`'s reason. This is the only reference to `Payment`
    // there is, which is exactly why the other spelling survived here: the component's `null`
    // was accidentally honest, and the next reference to a Payment would have inherited it.
    payment: z.union([Payment, z.null()]).meta({
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
  "variant-unavailable": "variant-unavailable",
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
