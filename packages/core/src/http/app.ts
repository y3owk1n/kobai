import { Hono } from "hono";
import type { Logger } from "../config.ts";
import type { Database } from "../db/client.ts";
import type { MigrationStateHolder } from "../migrations/state.ts";
import { createAdminRoutes } from "./admin.ts";
import { health, requireMigrationsApplied } from "./health.ts";
import { createStoreRoutes } from "./store.ts";

export type HttpDependencies = {
  readonly db: Database;
  readonly migrations: MigrationStateHolder;
  readonly logger: Logger;
};

/**
 * Core's HTTP surface.
 *
 * `/health` is always answerable, including before migrations have run and after they have
 * failed — that is the whole point of it. Everything else is gated on migrations having
 * applied, so the application never serves traffic against a half-migrated schema, and each
 * of the two authenticated surfaces is gated again on its own credential: `/admin` on a
 * Merchant session (see `./admin.ts`), `/store` on an API key (see `./store.ts`).
 */
export function createHttpApp(deps: HttpDependencies): Hono {
  const app = new Hono();

  // Every failure leaves the process as one JSON line and reaches the client as one JSON
  // body. Hono's default writes a stack trace to stdout and plain text to the client, which
  // is two shapes to parse and a stack trace handed to whoever asked.
  app.onError((error, c) => {
    deps.logger.error("request failed", {
      method: c.req.method,
      path: c.req.path,
      reason: error.message,
    });
    return c.json({ error: "Internal Server Error" }, 500);
  });

  app.get("/health", (c) => {
    const body = health(deps.migrations.get());
    return c.json(body, body.status === "ok" ? 200 : 503);
  });

  const admin = new Hono();
  admin.use("*", requireMigrationsApplied(deps.migrations));
  admin.route("/", createAdminRoutes({ db: deps.db }));
  app.route("/admin", admin);

  // The second authenticated surface, and a second gate rather than a second credential for
  // the first one: `/store` is opened by an API key, `/admin` by a Merchant session, and
  // neither credential is worth anything on the other surface (ADR-0020).
  const store = new Hono();
  store.use("*", requireMigrationsApplied(deps.migrations));
  store.route("/", createStoreRoutes({ db: deps.db }));
  app.route("/store", store);

  return app;
}
