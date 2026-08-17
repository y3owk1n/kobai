import { Hono } from "hono";
import type { Logger } from "../config.ts";
import type { Database } from "../db/client.ts";
import type { MigrationState, MigrationStateHolder } from "../migrations/state.ts";
import { readStore } from "../store/read.ts";

export type HttpDependencies = {
  readonly db: Database;
  readonly migrations: MigrationStateHolder;
  readonly logger: Logger;
};

/** What `GET /health` answers with. Shaped so a probe can act on `status` alone. */
export type HealthBody = {
  readonly status: "ok" | "booting" | "error";
  readonly migrations: MigrationState;
};

/**
 * Core's HTTP surface.
 *
 * `/health` is always answerable, including before migrations have run and after they have
 * failed — that is the whole point of it. Everything else is gated on migrations having
 * applied, so the application never serves traffic against a half-migrated schema.
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

  admin.use("*", async (c, next) => {
    const body = health(deps.migrations.get());
    if (body.status !== "ok") {
      return c.json({ error: REFUSAL[body.status], ...body }, 503);
    }
    await next();
  });

  admin.get("/store", async (c) => {
    const store = await readStore(deps.db);
    if (!store) {
      return c.json(
        { error: "No Store exists. The database is migrated but unseeded." },
        500,
      );
    }
    return c.json(store, 200);
  });

  app.route("/admin", admin);

  return app;
}

/** Why a route other than `/health` is refusing. Keyed by the same status `/health` reports. */
const REFUSAL = {
  booting:
    "kobai is still starting: its migrations have not applied yet. See GET /health.",
  error: "kobai is not serving: its migrations failed. See GET /health.",
} as const satisfies Record<Exclude<HealthBody["status"], "ok">, string>;

function health(migrations: MigrationState): HealthBody {
  switch (migrations.status) {
    case "applied":
      return { status: "ok", migrations };
    case "failed":
      return { status: "error", migrations };
    default:
      return { status: "booting", migrations };
  }
}
