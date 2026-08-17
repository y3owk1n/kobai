import type { MiddlewareHandler } from "hono";
import type { MigrationState, MigrationStateHolder } from "../migrations/state.ts";
import { GATE_REFUSALS, gateAnswering } from "./gate-refusals.ts";

/** What `GET /health` answers with. Shaped so a probe can act on `status` alone. */
export type HealthBody = {
  readonly status: "ok" | "booting" | "error";
  readonly migrations: MigrationState;
};

export function health(migrations: MigrationState): HealthBody {
  switch (migrations.status) {
    case "applied":
      return { status: "ok", migrations };
    case "failed":
      return { status: "error", migrations };
    default:
      return { status: "booting", migrations };
  }
}

/** Why a route other than `/health` is refusing. Keyed by the same status `/health` reports. */
const REFUSAL = {
  booting:
    "kobai is still starting: its migrations have not applied yet. See GET /health.",
  error: "kobai is not serving: its migrations failed. See GET /health.",
} as const satisfies Record<Exclude<HealthBody["status"], "ok">, string>;

/**
 * Holds every route but `/health` at 503 until migrations have applied, so the application
 * never serves traffic against a half-migrated schema.
 *
 * It runs *before* authentication, deliberately: a booting instance cannot check a session,
 * because the table it would check against may not exist yet.
 *
 * It is a gate like the credential ones, so it is built through `gateAnswering` like them:
 * the middleware carries the `503` it makes, and a route that sits behind it and declares no
 * `503` — or declares one without sitting behind it — fails the build. See
 * `./gate-refusals.ts`.
 */
export function requireMigrationsApplied(
  migrations: MigrationStateHolder,
): MiddlewareHandler {
  return gateAnswering(GATE_REFUSALS.unavailable, async (c, next) => {
    const body = health(migrations.get());
    if (body.status !== "ok") {
      return c.json({ error: REFUSAL[body.status], ...body }, 503);
    }
    await next();
  });
}
