import { readFileSync } from "node:fs";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { SessionPolicy } from "../auth/session.ts";
import { SESSION_COOKIE } from "../auth/session-cookie.ts";
import type { Logger } from "../config.ts";
import type { Database } from "../db/client.ts";
import type { FulfilmentStrategies } from "../fulfilment/strategy.ts";
import type { MigrationStateHolder } from "../migrations/state.ts";
import type { PlaceOrderWorkflow } from "../order/place-order.ts";
import type { PaymentProvider } from "../payment/provider.ts";
import type { PriceResolutionWorkflow } from "../pricing/resolve-price.ts";
import type { WorkflowRegistry } from "../workflow/context.ts";
import { createAdminRoutes } from "./admin.ts";
import * as contract from "./contract.ts";
import { health, requireMigrationsApplied } from "./health.ts";
import { json, type OpenApiDocument, SECURITY_SCHEMES } from "./openapi.ts";
import { createStoreRoutes } from "./store.ts";

export type HttpDependencies = {
  readonly db: Database;
  /**
   * The Fulfilment Strategies this deployment has — Core's two, with whatever the Project
   * wired over them (ADR-0052).
   *
   * Threaded through rather than imported by the modules that ask, because it is a property of
   * the instance: the admin surface refuses a Variant pointing at one this deployment does not
   * have, and `place-order` asks each line's Strategy what it answers.
   */
  readonly fulfilment: FulfilmentStrategies;
  readonly migrations: MigrationStateHolder;
  readonly logger: Logger;
  /**
   * The `resolve-price` declaration this deployment runs — Core's, or the one the Project's
   * config rebuilt. Threaded through to the store surface rather than imported there.
   */
  readonly priceWorkflow: PriceResolutionWorkflow;
  /** The `place-order` declaration this deployment runs, for the same reason. */
  readonly placeOrderWorkflow: PlaceOrderWorkflow;
  /**
   * Every declaration this deployment runs, so a Step that invokes another Workflow reaches
   * this deployment's version of it (ADR-0054).
   */
  readonly workflows: WorkflowRegistry;
  /**
   * The Payment Provider this deployment was wired with, or `undefined` if it was wired with
   * none — which is a deployment that serves everything except the placing of an Order
   * (ADR-0053).
   */
  readonly paymentProvider: PaymentProvider | undefined;
  /**
   * How long this deployment's sessions live — the default, or what its `kobai.config.ts`
   * said (ADR-0050). Threaded through rather than imported by the modules that need it,
   * because it is a property of the instance: the admin gate enforces it, and the OpenAPI
   * description of `Session` reports it, so a description generated from this app is a
   * description of *these* numbers.
   */
  readonly sessionPolicy: SessionPolicy;
  /**
   * How long this deployment holds a Cart's stock while an Order is being placed — the
   * default, or what its `kobai.config.ts` said (ADR-0075). Threaded through for
   * `sessionPolicy`'s reason: it is a property of the instance, and the Step that claims
   * stock reads it off the Workflow context this surface builds.
   */
  readonly holdWindowMs: number;
};

/** Where `coreVersion` reads from — `@kobai/core`'s own manifest, beside its `dist`. */
const CORE_MANIFEST_PATH = new URL("../../package.json", import.meta.url);

/**
 * The release this surface belongs to, read from `@kobai/core`'s own manifest.
 *
 * ADR-0060 puts the HTTP surface under Core's semver promise, so the surface's version *is*
 * the package's — one fact, and this reads it rather than restating it. A second copy kept
 * by hand would be the thing ADR-0049 refuses for a migration count: a number written down
 * where it is already recorded, agreeing right up until somebody forgets.
 *
 * The manifest is found relative to this module's *built* output, exactly as
 * `OPENAPI_DOCUMENT_PATH` finds the description: `rootDir` is `src` and `outDir` is `dist`,
 * so `../../` is the package root in the source tree, in `dist`, and in the tarball a
 * Project installs. npm puts a `package.json` in every tarball whatever `files` says, and
 * `exports` already names `./package.json` for the upgrade command, so nothing further has
 * to be arranged for this to resolve.
 *
 * **It is read when a description is asked for, and never at import.** A Project boots this
 * module and asks for no description at all — `kobai.openapi()` is already lazy, and ADR-0040
 * keeps the description off the served surface entirely — so a manifest read at module scope
 * would put a synchronous file read, and an import-time throw, in front of every boot for a
 * value only the generator and the tests want. Every other package-relative path in this
 * repository resolves eagerly and reads late for the same reason: `OPENAPI_DOCUMENT_PATH`
 * and each migration set's folder are URLs, opened at use.
 *
 * A manifest with no `version` throws rather than returning `undefined`, because
 * `JSON.stringify` drops an undefined value and the result would be a description missing a
 * field OpenAPI requires — an invalid document produced silently, which is worse than no
 * document.
 */
export function coreVersion(): string {
  const manifest = JSON.parse(readFileSync(CORE_MANIFEST_PATH, "utf8")) as {
    version?: string;
  };
  if (manifest.version === undefined) {
    throw new Error(`${CORE_MANIFEST_PATH.pathname} declares no version`);
  }
  return manifest.version;
}

/**
 * The document's own metadata — the only part of the description not derived from a route.
 *
 * It is a function rather than a constant for one reason: `version` is the API's, and it is
 * `@kobai/core`'s, read rather than written here — so a description and the build that
 * produced it can never disagree about which kobai this is.
 *
 * What *can* disagree is the artifact checked into `packages/core/openapi.json`, because that
 * only moves when somebody regenerates it. **A version bump is therefore one
 * `devbox run openapi:generate` away from green**, and until it is run both checks in
 * `openapi.test.ts` fail: the byte comparison as a diff, and the version assertion by name.
 * `packages/client/src/schema.test.ts` is *not* one of them — `openapi-typescript` emits the
 * paths, components and operations and never the `info` block, so a regenerated client is
 * byte-identical across a version bump. That churn is accepted rather than overlooked: every
 * answer that puts a release in the artifact has it, and the only answer that does not is
 * leaving the description naming no release at all.
 *
 * Which was the previous answer, and `0.0.0` is not a silence. OpenAPI requires
 * `info.version`, so omitting it was never on the table; and this file ships *inside* a
 * package that `tests/publish-guard.test.ts` fails the build for carrying that exact
 * version, on the grounds that it "is not a starting point, it is an absence" (ADR-0034).
 *
 * It matters because the description is how a Developer who does not write TypeScript
 * consumes this surface — ADR-0006 rejected tRPC precisely so they need not share kobai's
 * language — and the file on their disk carries no manifest beside it. ADR-0060 leaves the
 * `info` block's *serialisation* unpromised; the surface it describes is promised, and the
 * description now says which release of that promise it is describing.
 *
 * **So whatever moves the manifest's version has to regenerate the artifact beside it**, and
 * nothing outside this repository enforces that. `tests/support/local-registry.ts` already
 * rewrites the version while repacking a tarball, so the upgrade gate's synthetic major
 * serves one version and carries a checked-in description naming another; nothing asks it
 * the question, so nothing is wrong today. A release process that bumps at publish time
 * rather than in a commit would ship that mismatch to a Developer — **so it is decided in
 * advance rather than when the first publish is arranged**: the version is bumped in a
 * commit, with the artifacts regenerated in that same commit. That is one entry on the list
 * of what the first publish owes, `docs/adr/0061-what-the-first-publish-owes.md`, which is
 * the record to read before removing a loopback registry pin from any manifest.
 *
 * Everything else about the description comes from the routes themselves.
 */
function documentMetadata() {
  return {
    openapi: "3.1.0",
    info: {
      title: "kobai",
      version: coreVersion(),
      description:
        "kobai's HTTP surface. Two authenticated surfaces: `/admin`, behind a Merchant session in an httpOnly cookie, and `/store`, behind a bearer API key (ADR-0020, ADR-0032). `/health` is open, and is the only route that answers before migrations have applied.",
      license: { name: "MIT", identifier: "MIT" },
    },
  } as const;
}

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  summary: "Migration state",
  description:
    "Answerable throughout a boot, including before migrations have run and after they have failed — that is the whole point of it. It reports what the migration run recorded, so it is not a database liveness check.",
  responses: {
    200: json("Migrations have applied and kobai is serving.", contract.Health),
    503: json(
      "Still starting, or not serving because migrations failed.",
      contract.Health,
    ),
  },
});

/**
 * Core's HTTP surface.
 *
 * `/health` is always answerable, including before migrations have run and after they have
 * failed — that is the whole point of it. Everything else is gated on migrations having
 * applied, so the application never serves traffic against a half-migrated schema, and each
 * of the two authenticated surfaces is gated again on its own credential: `/admin` on a
 * Merchant session (see `./admin.ts`), `/store` on an API key (see `./store.ts`).
 *
 * The app is an `OpenAPIHono`, which is what makes the OpenAPI description a *product* of
 * building this rather than a document written beside it. Both sub-apps are `OpenAPIHono`
 * too, and they must be: a plain `Hono` in the middle knows nothing about the description
 * and its children's routes would be served and undescribed.
 */
export function createHttpApp(deps: HttpDependencies): OpenAPIHono {
  // No `defaultHook` on the three apps in this file: a hook answers a request that did not
  // fit its route's schema, and none of the routes here or these two wrappers has one to
  // fit. It is set where routes with schemas are registered — `admin.ts` and `store.ts`.
  const app = new OpenAPIHono();

  // Every failure leaves the process as one JSON line and reaches the client as one JSON
  // body. Hono's default writes a stack trace to stdout and plain text to the client, which
  // is two shapes to parse and a stack trace handed to whoever asked.
  app.onError((error, c) => {
    // Hono's own request reader raises this when a body will not parse as JSON at all, and
    // it arrives here rather than at a route's schema because it fails before the schema is
    // reached. It is the client's mistake: answering 500 would tell them the server is
    // broken and page an operator about a typo. `malformed-body` stays distinct from the
    // `invalid` a schema failure answers with — one body cannot be read, the other reads
    // fine and does not fit, and they have different fixes. kobai's own code raises no
    // `HTTPException`, so this is the whole of what reaches it.
    if (error instanceof HTTPException) {
      return c.json({ error: error.message, reason: "malformed-body" }, error.status);
    }

    deps.logger.error("request failed", {
      method: c.req.method,
      path: c.req.path,
      reason: error.message,
    });
    return c.json({ error: "Internal Server Error" }, 500);
  });

  /**
   * Anything no route answered — the one refusal a client cannot anticipate.
   *
   * Every other refusal is declared: a route names the statuses it answers with, those reach
   * `packages/core/openapi.json`, and `@kobai/client` turns them into a union a storefront
   * narrows on. This one belongs to no route, which is exactly why it used to be the odd
   * shape out: Hono's own 404 is plain text, so a client got JSON for every failure it could
   * plan for and text for the one it could not, and found out at runtime (#33).
   *
   * **One handler for the whole application**, rather than one per surface. A typo at the
   * root is the same mistake as a typo under `/admin`, and a Project hands kobai every path
   * it does not serve itself (`reference/src/app.ts`), so the surface that has to answer in
   * one shape is all of it. A request with a known path and an unserved method lands here
   * too, and is reported as a path that is not there: distinguishing the two would mean
   * enumerating the methods of every path, which the description already does for anyone who
   * needs the list.
   *
   * **It is not a route, so it is deliberately absent from the description** — the same
   * bargain the store surface's catch-all made before this replaced it. A description
   * enumerates the paths that exist; this answers the paths that do not. A generated client
   * therefore has no type for this body, which is consistent rather than a gap: it also has
   * no way to make the call that produces one.
   *
   * **It never runs before a gate.** Hono reaches a not-found handler only after every
   * middleware that matched has called `next()`, and both surfaces mount their credential
   * gate with `use("*")` — so an anonymous request to a nonexistent `/admin` path is answered
   * 401 by the session gate and never gets here. That is the intended order (ADR-0040): an
   * anonymous caller is told the same thing about a path that exists and a path that does
   * not, and cannot map either surface by watching which ones 404.
   */
  app.notFound((c) =>
    c.json(
      {
        error: `kobai serves no ${c.req.method} ${c.req.path}.`,
        reason: "not-found" as const,
      },
      404,
    ),
  );

  app.openapi(healthRoute, (c) => {
    const body = health(deps.migrations.get());
    return c.json(body, body.status === "ok" ? 200 : 503);
  });

  const admin = new OpenAPIHono();
  admin.use("*", requireMigrationsApplied(deps.migrations));
  admin.route(
    "/",
    createAdminRoutes({
      db: deps.db,
      fulfilment: deps.fulfilment,
      sessionPolicy: deps.sessionPolicy,
    }),
  );
  app.route("/admin", admin);

  // The second authenticated surface, and a second gate rather than a second credential for
  // the first one: `/store` is opened by an API key, `/admin` by a Merchant session, and
  // neither credential is worth anything on the other surface (ADR-0020).
  const store = new OpenAPIHono();
  store.use("*", requireMigrationsApplied(deps.migrations));
  store.route(
    "/",
    createStoreRoutes({
      db: deps.db,
      fulfilment: deps.fulfilment,
      priceWorkflow: deps.priceWorkflow,
      placeOrderWorkflow: deps.placeOrderWorkflow,
      workflows: deps.workflows,
      paymentProvider: deps.paymentProvider,
      holdWindowMs: deps.holdWindowMs,
    }),
  );
  app.route("/store", store);

  // Registered after the sub-apps, because `route()` copies a child's registry at the moment
  // it is called and the schemes have to be in the parent's when the document is asked for.
  app.openAPIRegistry.registerComponent(
    "securitySchemes",
    SECURITY_SCHEMES.merchantSession,
    {
      type: "apiKey",
      in: "cookie",
      name: SESSION_COOKIE,
      description:
        "A Merchant session, set by `POST /admin/session` as an httpOnly cookie and sent back by the browser by itself. Opens `/admin` and nothing else. httpOnly, `SameSite=Strict`, and `Secure` whenever the request arrived over HTTPS — so the token is in no response body and reachable by no script (ADR-0032). It names no `Path`, so the browser scopes it to the admin surface it was issued from, wherever the Project mounted kobai.",
    },
  );
  app.openAPIRegistry.registerComponent("securitySchemes", SECURITY_SCHEMES.apiKey, {
    type: "http",
    scheme: "bearer",
    bearerFormat: "kobai_pk_… | kobai_sk_…",
    description:
      "An API key, from `POST /admin/api-keys`. Opens `/store` and nothing else. The prefix says which kind it is, with no lookup: `kobai_pk_` is publishable and safe in a browser, `kobai_sk_` is secret and is not.",
  });

  return app;
}

/**
 * The OpenAPI description of a running kobai.
 *
 * Taken from the app object that serves the requests, so there is no second declaration to
 * keep in step with the first. `packages/core/openapi.json` is this, written to a file, and
 * `openapi.test.ts` fails the build when the two disagree.
 */
export function describeHttpApp(app: OpenAPIHono): OpenApiDocument {
  return app.getOpenAPI31Document(documentMetadata());
}
