import { Hono } from "hono";
import type { Logger } from "../config.ts";
import type { Database } from "../db/client.ts";
import type { MigrationStateHolder } from "../migrations/state.ts";
import { createAdminRoutes } from "./admin.ts";
import { health, requireMigrationsApplied } from "./health.ts";

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
 * applied, so the application never serves traffic against a half-migrated schema, and the
 * admin surface is gated again on a Merchant session (see `./admin.ts`).
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

  return app;
}
