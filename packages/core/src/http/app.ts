import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { Logger } from "../config.ts";
import type { Database } from "../db/client.ts";
import type { MigrationStateHolder } from "../migrations/state.ts";
import type { PriceResolutionWorkflow } from "../pricing/resolve-price.ts";
import { createAdminRoutes } from "./admin.ts";
import * as contract from "./contract.ts";
import { health, requireMigrationsApplied } from "./health.ts";
import { json, type OpenApiDocument, SECURITY_SCHEMES } from "./openapi.ts";
import { createStoreRoutes } from "./store.ts";

export type HttpDependencies = {
  readonly db: Database;
  readonly migrations: MigrationStateHolder;
  readonly logger: Logger;
  /**
   * The `resolve-price` declaration this deployment runs — Core's, or the one the Project's
   * config rebuilt. Threaded through to the store surface rather than imported there.
   */
  readonly priceWorkflow: PriceResolutionWorkflow;
};

/**
 * The document's own metadata — the only part of the description not derived from a route.
 *
 * `version` is the API's, and it moves with `@kobai/core`'s. Everything else about the
 * description comes from the routes themselves.
 */
const DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "kobai",
    version: "0.0.0",
    description:
      "kobai's HTTP surface. Two authenticated surfaces: `/admin`, behind a Merchant session, and `/store`, behind an API key (ADR-0020). `/health` is open, and is the only route that answers before migrations have applied.",
    license: { name: "MIT", identifier: "MIT" },
  },
} as const;

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

  app.openapi(healthRoute, (c) => {
    const body = health(deps.migrations.get());
    return c.json(body, body.status === "ok" ? 200 : 503);
  });

  const admin = new OpenAPIHono();
  admin.use("*", requireMigrationsApplied(deps.migrations));
  admin.route("/", createAdminRoutes({ db: deps.db }));
  app.route("/admin", admin);

  // The second authenticated surface, and a second gate rather than a second credential for
  // the first one: `/store` is opened by an API key, `/admin` by a Merchant session, and
  // neither credential is worth anything on the other surface (ADR-0020).
  const store = new OpenAPIHono();
  store.use("*", requireMigrationsApplied(deps.migrations));
  store.route("/", createStoreRoutes({ db: deps.db, priceWorkflow: deps.priceWorkflow }));
  app.route("/store", store);

  // Registered after the sub-apps, because `route()` copies a child's registry at the moment
  // it is called and the schemes have to be in the parent's when the document is asked for.
  app.openAPIRegistry.registerComponent(
    "securitySchemes",
    SECURITY_SCHEMES.merchantSession,
    {
      type: "http",
      scheme: "bearer",
      description:
        "A Merchant session token, from `POST /admin/session`. Opens `/admin` and nothing else.",
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
  return app.getOpenAPI31Document(DOCUMENT);
}
