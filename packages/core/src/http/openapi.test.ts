import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_SESSION_POLICY } from "../auth/session.ts";
import { CORE_FULFILMENT_STRATEGIES } from "../fulfilment/strategy.ts";
import { filesystemMediaStorage, resolveMediaPolicy } from "../media/storage.ts";
import { createMigrationStateHolder } from "../migrations/state.ts";
import { placeOrderWorkflow } from "../order/place-order.ts";
import { priceResolutionWorkflow } from "../pricing/resolve-price.ts";
import { DEFAULT_RESERVATION_HOLD_WINDOW_MS } from "../reservation/reservation.ts";
import { silentLogger } from "../testing/kobai.ts";
import { coreVersion, createHttpApp, describeHttpApp } from "./app.ts";
import { GATE_REFUSALS, type GateRefusal, refusalAnsweredBy } from "./gate-refusals.ts";
import { OPENAPI_DOCUMENT_PATH, openApiJson, SECURITY_SCHEMES } from "./openapi.ts";

/**
 * The OpenAPI description, and the one thing that has to stay true about it: that it
 * describes *this* application and not a remembered one.
 *
 * There is no assertion here about what the description says a Product looks like, and
 * there should not be — a test that repeated the schemas would be a second hand-maintained
 * copy of them, which is the failure the description exists to avoid. What is asserted is
 * the relationship between the description and the routes: that every route the router
 * serves is in it, that nothing in it is unserved, and that the file checked into the
 * repository is what this build produces.
 *
 * The app is built here rather than through `createTestKobai`, because none of this needs a
 * database: a description is a property of the routes.
 */
function describeCore() {
  const app = createHttpApp({
    // Never used: nothing below dispatches a request.
    db: undefined as never,
    migrations: createMigrationStateHolder(),
    logger: silentLogger,
    // Core's own, rather than a Project's rewiring of them. A replaced Step changes which
    // Step runs and never which routes exist, so the description does not move with it —
    // and a test that boots a Project's config to assert that would be asserting nothing.
    priceWorkflow: priceResolutionWorkflow,
    placeOrderWorkflow,
    // Empty for the same reason: composition decides what a Step reaches, never what is
    // served, and nothing below dispatches a request.
    workflows: {},
    // None, because Core ships none (ADR-0053) and a description does not move with one: a
    // deployment that wired a provider serves exactly these routes and answers exactly these
    // statuses — 402 among them, whether or not anything is there to decline.
    paymentProvider: undefined,
    // Core's own two, because a description does not move with a wired Strategy either: the set
    // is open (ADR-0014), so no schema here enumerates it and a deployment that wired a Plugin's
    // serves exactly these routes.
    fulfilment: CORE_FULFILMENT_STRATEGIES,
    // The storage kobai ships, because a description does not move with a substituted one
    // either: which `MediaStorage` a deployment wired decides what a `url` says and never which
    // routes exist. Nothing below dispatches a request, so nothing is written anywhere.
    mediaStorage: filesystemMediaStorage(),
    // Core's own ceiling and accepted set, because `packages/core/openapi.json` is the
    // description of stock kobai — and this one *does* reach the document, in the upload
    // route's prose, exactly as the session policy reaches `Session`'s. What a *configured*
    // pair does to it is asserted through the running application, in `media/media.test.ts`.
    mediaPolicy: resolveMediaPolicy(),
    // The default, because `packages/core/openapi.json` is the description of stock kobai.
    // What a *configured* window does to it is asserted through the running application, in
    // `auth/auth.test.ts`.
    sessionPolicy: DEFAULT_SESSION_POLICY,
    // The default likewise, and unlike the session's it reaches no schema at all: no route
    // reports a hold's deadline, so nothing here moves with it (ADR-0075).
    holdWindowMs: DEFAULT_RESERVATION_HOLD_WINDOW_MS,
  });
  return { app, document: describeHttpApp(app) };
}

/**
 * Every path and method the router will actually answer, in OpenAPI's spelling.
 *
 * Taken from Hono's own route table, which is what dispatch reads — so a route added with
 * a plain `app.get(…)` instead of a declaration shows up here and nowhere else, and the
 * comparison below fails. That is the whole point: the description cannot be kept correct
 * by remembering to update it.
 */
function servedOperations(routes: readonly RouteEntry[]): string[] {
  const served = routes
    // `ALL` is what a wildcard mount registers as, and there are exactly three paths:
    // `/admin/*`, `/store/*` and `/media/*`, carrying the migration gate and the two
    // credential gates.
    // None of them is a path a caller asks for by name, and a description enumerates paths,
    // so none belongs in one. The JSON 404 an unrouted path gets is not here at all — it is
    // `app.notFound`, which is not a route (ADR-0040).
    .filter((route) => route.method !== "ALL")
    .map(operationOf);

  return [...new Set(served)].sort();
}

/** One row of Hono's route table: a method, a path, and what dispatch runs for it. */
type RouteEntry = {
  readonly method: string;
  readonly path: string;
  readonly handler: unknown;
};

/**
 * How a route table row is named as an operation — OpenAPI's spelling of Hono's path.
 *
 * The two differ in one way: a parameter is `:id` in the router and `{id}` in a description.
 */
function operationOf(route: RouteEntry): string {
  return `${route.method.toLowerCase()} ${route.path.replace(/:(\w+)/g, "{$1}")}`;
}

/** Every HTTP method OpenAPI lets a path item carry — everything else on one is metadata. */
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/**
 * How many operations this surface has, **asked of the router rather than written down**.
 *
 * Every scan below reads the *description*, and a scan that silently found none would pass
 * every assertion made over it — so each one is held to a length, and the length has to come
 * from somewhere the scan is not reading. Hono's own route table is that somewhere: it is the
 * thing dispatch consults, it is the other half of the comparison the first check in this file
 * already makes, and it moves when a route is added whether or not anybody regenerated
 * anything.
 *
 * This used to be `const OPERATIONS = 39`, bumped by hand in this file and again in
 * `auth/auth.test.ts` by every ticket that added a route — three counts across two files, and
 * #171, #172 and #173 each moved all three. ADR-0049 ruled on exactly that tax for migration
 * counts and its answer is the one applied here: derive it, but never from the side the
 * assertion is checking, and keep the pairing the count cannot make on its own.
 *
 * The emptiness guard is the other half, and it is not redundant: a derived count agrees with
 * itself, so two empty lists compare equal. `servedOperations` returning nothing means the app
 * registered no routes, and every check in this file would then pass by scanning nothing.
 */
function servedOperationCount(routes: readonly RouteEntry[]): number {
  const served = servedOperations(routes);
  expect(served.length, "the router registered no routes at all").toBeGreaterThan(0);
  return served.length;
}

/**
 * Every operation the description carries, paired with what the description says about it.
 *
 * A path item holds metadata beside its methods, so the methods are picked out by name rather
 * than by taking every key. What an operation *is* is the caller's to name: by the time it is
 * in the document it is plain JSON, and each check below reads one field of it.
 */
function documentedOperations<Described>(
  paths: Record<string, object>,
): { operation: string; described: Described }[] {
  return Object.entries(paths).flatMap(([path, item]) =>
    Object.entries(item as Record<string, Described>)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, described]) => ({ operation: `${method} ${path}`, described })),
  );
}

describe("the description is generated from the routes", () => {
  it("describes every route the router serves, and no route it does not", () => {
    const { app, document } = describeCore();

    const documented = documentedOperations(document.paths ?? {});

    expect(documented.map(({ operation }) => operation).sort()).toEqual(
      servedOperations(app.routes),
    );
  });

  it("is checked into the repository exactly as this build produces it", async () => {
    const { document } = describeCore();

    const checkedIn = await readFile(OPENAPI_DOCUMENT_PATH, "utf8");

    // Regenerate with `devbox run openapi:generate`, which rewrites this file and then the
    // client generated from it. A failure here is drift, which is the whole reason the
    // description is generated rather than written.
    expect(openApiJson(document)).toBe(checkedIn);
  });
});

/**
 * Which release the description says it is describing.
 *
 * Its own block rather than one more case above, because the version is the one thing in the
 * document that is *not* derived from a route: it is `@kobai/core`'s, read out of the manifest
 * (ADR-0060 puts the HTTP surface under Core's semver promise, so the surface's version is the
 * package's).
 */
describe("the description names the release it describes", () => {
  it("carries @kobai/core's version, in the artifact that is checked in", async () => {
    const checkedIn = JSON.parse(await readFile(OPENAPI_DOCUMENT_PATH, "utf8")) as {
      info: { version?: string };
    };

    // Deliberately the file on disk rather than `describeCore().document`, which reads the
    // same manifest and so could only ever agree with it. The artifact is the second source:
    // it moves when somebody regenerates it and at no other time, so this is the assertion
    // that a version bump was followed by `devbox run openapi:generate` — and it names the
    // two versions, where the byte comparison above reports an unreadable diff.
    //
    // `packages/client/src/schema.test.ts` is not a third check on this: openapi-typescript
    // emits paths, components and operations and never the `info` block, so a regenerated
    // client is byte-identical across a version bump.
    expect(checkedIn.info.version).toBe(coreVersion());

    // A version missing from both sides would make the line above pass by finding nothing —
    // ADR-0049's "two empty lists are equal" in a new place. `coreVersion` refuses such a
    // manifest rather than returning `undefined`, and this says so at the seam that would
    // otherwise absorb it. Whether the version is a *real* one rather than `0.0.0` is
    // `tests/publish-guard.test.ts`'s question, and it already asks it.
    expect(checkedIn.info.version).toEqual(expect.any(String));
  });
});

/**
 * Which scheme an operation must name, from where it sits.
 *
 * **Three** operations name none, and every one of them is written out here rather than
 * inferred from an absence, because "this route is open" is exactly the claim that must not be
 * arrivable at by accident:
 *
 * - `GET /health` is open on purpose (ADR-0048), and answers before migrations have applied.
 * - `POST /admin/session` is what *mints* a session, so requiring one would leave nobody able
 *   to obtain the first.
 * - `GET /media/{key}` serves image bytes to an `<img>`, which sends no credential — so there
 *   is no gate it could sit behind and still do its job. That is a decision rather than an
 *   omission and it is argued at the route in `http/app.ts`: everything the storage kobai ships
 *   holds is readable by anyone who knows a key, the keys are unguessable, and nothing there
 *   enumerates. **A fourth entry in this list is a new open route**, which is a thing to weigh
 *   rather than a line to add.
 *
 * Everything else is behind its surface's gate, with no exceptions — `POST /admin/merchants`
 * was one until #25.
 */
const OPEN_OPERATIONS = ["get /health", "post /admin/session", "get /media/{key}"];

function expectedSchemes(operation: string): string[] {
  if (OPEN_OPERATIONS.includes(operation)) return [];
  return operation.includes(" /store/")
    ? [SECURITY_SCHEMES.apiKey]
    : [SECURITY_SCHEMES.merchantSession];
}

describe("the description covers both surfaces, including how each is opened", () => {
  it("names the two schemes as two, because they open two surfaces", () => {
    const { document } = describeCore();

    // One scheme covering both would let a generated client send a storefront's key at
    // `/admin` and call it a type-correct request (ADR-0020). Since ADR-0032 they do not
    // even arrive the same way: the admin surface is opened by a cookie a browser carries
    // by itself, and the store surface by a bearer key a server sends deliberately.
    expect(document.components?.securitySchemes).toEqual({
      [SECURITY_SCHEMES.merchantSession]: {
        type: "apiKey",
        in: "cookie",
        name: "kobai_session",
        description: expect.any(String),
      },
      [SECURITY_SCHEMES.apiKey]: {
        type: "http",
        scheme: "bearer",
        bearerFormat: expect.any(String),
        description: expect.any(String),
      },
    });
  });

  it("names a scheme on every operation, and the right one for its surface", () => {
    const { app, document } = describeCore();

    // Per operation rather than per surface: a union over `/admin` would stay unchanged
    // when one guarded route simply forgot to name its scheme, and that omission is
    // exactly the mistake worth catching on a surface that is closed by default.
    const schemes = documentedOperations<{ security?: object[] }>(document.paths ?? {});

    for (const { operation, described } of schemes) {
      const named = (described.security ?? []).flatMap((requirement) =>
        Object.keys(requirement),
      );
      expect(named, operation).toEqual(expectedSchemes(operation));
    }

    expect(schemes).toHaveLength(servedOperationCount(app.routes));
  });

  it("describes the refusal each gate makes, so a client can tell them apart", () => {
    const { document } = describeCore();
    const schemas = document.components?.schemas ?? {};

    // The reasons are in the description, not only in the prose: a client narrowing on
    // `reason` gets a union rather than `string`.
    expect(schemas.SessionRefusal).toMatchObject({
      properties: {
        reason: {
          enum: [
            "session-missing",
            "session-malformed",
            "session-unknown",
            "session-expired",
          ],
        },
      },
    });
    expect(schemas.ApiKeyRefusal).toMatchObject({
      properties: {
        reason: {
          enum: [
            "api-key-missing",
            "api-key-malformed",
            "api-key-unknown",
            "api-key-revoked",
          ],
        },
      },
    });
    expect(schemas.PermissionDenied).toMatchObject({
      required: expect.arrayContaining(["required"]),
    });
  });
});

/**
 * Every gate refusal, by the description a route declaring one carries.
 *
 * The description is the identity because it *is* the declaration: a route writes
 * `403: REFUSALS.forbidden`, and the description that object holds is what reaches the
 * generated document. So nothing here has to spell a schema name or a status twice, and a
 * `REFUSALS` entry that gets reworded moves both sides of the comparison at once.
 */
const GATE_REFUSAL_BY_DESCRIPTION = new Map<string, GateRefusal>(
  Object.values(GATE_REFUSALS).map((refusal) => [
    refusal.declaredAs.description,
    refusal,
  ]),
);

/** One gate refusal, as the route table writes it: the status it makes, and which one it is. */
function labelled(refusal: GateRefusal): string {
  return labelledAt(String(refusal.status), refusal);
}

/**
 * The same, at the status a route *declared* it.
 *
 * Separate from {@link labelled} because the two are not always the same number, and when
 * they differ that is the finding: a route that declared `REFUSALS.forbidden` at some status
 * other than 403 reads as a mismatch rather than as a match.
 */
function labelledAt(status: string, refusal: GateRefusal): string {
  return `${status} ${refusal.name}`;
}

/**
 * The gate refusals an operation **declares**, at the statuses it declares them.
 *
 * The status comes from the declaration rather than from the refusal, so a route that
 * declared `REFUSALS.forbidden` at the wrong status is a mismatch rather than a match.
 * Everything else in `responses` is the handler's own and is not this check's business —
 * the compiler already holds a handler to what its route declared.
 */
function declaredGateRefusals(responses: Record<string, { description?: string }>) {
  return Object.entries(responses)
    .flatMap(([status, response]) => {
      const refusal = GATE_REFUSAL_BY_DESCRIPTION.get(response.description ?? "");
      return refusal === undefined ? [] : [labelledAt(status, refusal)];
    })
    .sort();
}

/**
 * The gate refusals an operation **sits behind**, read off Hono's own route table.
 *
 * The table is the thing dispatch reads, which is why the answer is taken from it rather than
 * from the `createRoute` objects: a gate mounted with a bare `use("*")` is in the table and in
 * no declaration, and a `middleware: [requirePermission(…)]` that was deleted leaves the table
 * exactly as if it had never been written.
 *
 * Two rules decide which gates are in front of a given operation, and both are properties of
 * how Hono dispatches rather than guesses about it:
 *
 * - **Path and method**, with `ALL` matching every method and a trailing `/*` matching
 *   everything below it. The only wildcards this application mounts are `/admin/*` and
 *   `/store/*`.
 * - **Registration order.** Hono runs matching handlers in the order they were registered and
 *   stops at the first one that answers without calling `next()`, so a gate registered *after*
 *   a route's own handler never runs for it. That is not a detail — it is exactly what makes
 *   `POST /admin/session` reachable without a session while sitting under the same `/admin/*`
 *   guard as everything else.
 *
 * **Nothing is excused from this.** `POST /admin/merchants` was, until #25: it could carry
 * neither `requireSession` nor `requirePermission`, because the *first* Merchant had to be
 * creatable with no session at all, so it asked the same question inside its handler and was
 * named here on the strength of that. The first Merchant is seeded at boot now, the route
 * carries the ordinary middleware, and every refusal every operation declares is made by a
 * gate this function can see.
 */
function refusalsGating(routes: readonly RouteEntry[]): Map<string, string[]> {
  const gates = routes.flatMap((route, index) => {
    const refusal = refusalAnsweredBy(route.handler);
    return refusal === undefined ? [] : [{ index, route, refusal }];
  });

  const gating = new Map<string, string[]>();

  routes.forEach((route, index) => {
    if (route.method === "ALL") return;
    const operation = operationOf(route);
    const answered = gates
      .filter((gate) => gate.index <= index && covers(gate.route, route))
      .map((gate) => labelled(gate.refusal));

    // An operation is several rows — its middleware, its validators, its handler — and the
    // last of them is the handler, so setting on every row leaves the entry that saw the
    // whole chain.
    gating.set(operation, answered.sort());
  });

  return gating;
}

/** Whether `gate` is in front of `route`: same method, and a path that reaches it. */
function covers(gate: RouteEntry, route: RouteEntry): boolean {
  if (gate.method !== "ALL" && gate.method !== route.method) return false;
  return gate.path.endsWith("/*")
    ? route.path.startsWith(gate.path.slice(0, -1))
    : gate.path === route.path;
}

/**
 * The dimension #9's drift checks did not cover: that a refusal a route *declares* is one its
 * gates can actually *make*.
 *
 * A `403` used to be a comment. Since #9 it is a published contract — it is in
 * `packages/core/openapi.json` and in the union `@kobai/client` lets a storefront narrow on —
 * so a route promising a permission check it does not have, or holding one it never declared,
 * makes a generated client wrong in a way its types assert is right. Neither is visible to
 * anything else here: the `satisfies Record<…>` maps cover reason → status, and the compiler
 * covers handler → declaration, but no middleware appears in either.
 *
 * **It covers all four gate refusals, and not only the `403`.** The `401`s were worth the same
 * check for a blunter reason than the `403` was: both credential gates are mounted per surface
 * with `use("*")`, so the mistake to catch is not a forgotten decoration but a route registered
 * on the wrong half of `admin.ts` — which is the whole admin surface answering anonymously, and
 * nothing else here would notice. The `503` comes free with the same machinery. What the check
 * deliberately stops at is the status: whether a `401` can really carry every `session-` or
 * `api-key-` reason it declares is pinned one level down, by the mapped `satisfies` on
 * `SESSION_REASONS` and `API_KEY_REASONS` in `contract.ts`, which the compiler enforces and a
 * test could only repeat. Everything else a route declares — `400`, `404`, `409`, `422`, `500` —
 * is the handler's own, and `app.openapi` already types the handler against it.
 */
describe("a declared refusal is one a gate actually makes", () => {
  it("declares every refusal its gates make, and no refusal they do not", () => {
    const { app, document } = describeCore();

    const gating = refusalsGating(app.routes);
    const operations = documentedOperations<{ responses?: Record<string, object> }>(
      document.paths ?? {},
    );

    // Both directions, each named in words rather than left to be read off the sign of a
    // diff: the label says which route, and the key says which half is missing.
    for (const { operation, described } of operations) {
      const declared = declaredGateRefusals(described.responses ?? {});
      const gates = gating.get(operation) ?? [];

      expect(
        {
          declaredWithNoGate: declared.filter((refusal) => !gates.includes(refusal)),
          gatedButNotDeclared: gates.filter((refusal) => !declared.includes(refusal)),
        },
        operation,
      ).toEqual({ declaredWithNoGate: [], gatedButNotDeclared: [] });
    }

    expect(operations).toHaveLength(servedOperationCount(app.routes));
  });

  it("reads the whole chain, not just the route's own middleware", () => {
    const { app } = describeCore();

    // A worked example, so the loop above cannot pass by finding no gates at all: reading
    // `app.ts` and `admin.ts`, `GET /admin/store` sits behind the migration gate, the session
    // gate, and its own `requirePermission(store:read)` — three mounts in three files.
    expect(refusalsGating(app.routes).get("get /admin/store")).toEqual([
      "401 noSession",
      "403 forbidden",
      "503 unavailable",
    ]);
  });

  it("puts no permission gate above the session gate that feeds it", () => {
    const { app, document } = describeCore();

    // The one way a declared 403 can still be a promise nothing keeps after the check above:
    // `requirePermission` reads the Merchant off the context, and `authenticated` throws when
    // there is none — so a route gated on a permission with no `requireSession` in front of it
    // answers 500 where it declared 403, and both halves of the check would agree it was fine.
    // `authenticated` says so at runtime; this says so at build, before anybody has to see it.
    const gated = [...refusalsGating(app.routes)].filter(([, refusals]) =>
      refusals.includes(labelled(GATE_REFUSALS.forbidden)),
    );

    for (const [operation, refusals] of gated) {
      expect(refusals, operation).toContain(labelled(GATE_REFUSALS.noSession));
    }

    // Every admin route names a permission except the three that manage the session itself:
    // `POST /admin/session` mints the one the others are read through, and `GET`/`DELETE`
    // need only a live one. That sentence used to end in `toHaveLength(26)`, which meant
    // every ticket adding an admin route came here to bump a number that says nothing the
    // sentence does not (#188).
    //
    // So the expectation is the sentence, and the two sides stay independent: `gated` is read
    // off Hono's route table, and what it is held to is read off the *description*. Naming the
    // three exceptions rather than subtracting three is what keeps it honest — a fourth
    // ungated admin route makes this fail instead of quietly moving the arithmetic along.
    const UNGATED_ADMIN_OPERATIONS = [
      "post /admin/session",
      "get /admin/session",
      "delete /admin/session",
    ];
    const adminOperations = documentedOperations(document.paths ?? {})
      .map(({ operation }) => operation)
      .filter((operation) => operation.split(" ")[1]?.startsWith("/admin"));

    expect(
      adminOperations.length,
      "the description carries no admin operations",
    ).toBeGreaterThan(UNGATED_ADMIN_OPERATIONS.length);
    expect(gated.map(([operation]) => operation).sort()).toEqual(
      adminOperations
        .filter((operation) => !UNGATED_ADMIN_OPERATIONS.includes(operation))
        .sort(),
    );
  });
});
