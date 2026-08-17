import { serve } from "@hono/node-server";
import { consoleLogger, createKobai } from "@kobai/core";
import config from "../kobai.config.ts";
import { ADMIN_PATH, createAdminAssets } from "./admin-assets.ts";
import { createProjectFetch } from "./app.ts";

/**
 * The reference Project's entrypoint — the whole of what a Project has to write to run
 * kobai. Read env, hand it to Core, bind a port, migrate, seed the first Merchant, and decide
 * what each failure means.
 *
 * The order matters. The listener is bound *before* migrations run, so `GET /health` can
 * answer throughout: a Developer, or a container orchestrator, can tell a booting instance
 * from a broken one instead of seeing the same connection refused for both. Core's own gate
 * keeps every other route at 503 until migrations have applied, so nothing is ever served
 * against a half-migrated schema.
 *
 * If a migration fails the process exits non-zero rather than lingering. A half-migrated
 * database that keeps its container alive is the failure mode worth avoiding.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  consoleLogger.error(
    "DATABASE_URL is not set. Copy .env.example to .env, or use `devbox run up`.",
  );
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const kobai = createKobai({
  ...config,
  databaseUrl,
  /**
   * Who this deployment's **first** Merchant is.
   *
   * Core has no unauthenticated write path, so there is no way to create one over HTTP on a
   * deployment that has none — nobody would hold the permission it needs. It is read here,
   * from the environment, because that is where this Project keeps its secrets; a Project
   * that keeps them in a vault or a mounted file builds the same object from there instead.
   * Both variables are documented in `.env.example`, and seeding happens after the
   * migrations below, because the table has to exist first.
   */
  initialMerchant: {
    email: process.env.KOBAI_INITIAL_MERCHANT_EMAIL,
    password: process.env.KOBAI_INITIAL_MERCHANT_PASSWORD,
  },
  logger: consoleLogger,
});

/**
 * One process serves both. The Admin is a directory of built files at `/admin-ui`, and every
 * other path is kobai's — one container, one origin, and so no CORS anywhere (ADR-0010).
 */
const fetch = createProjectFetch(kobai, createAdminAssets());

let boundPort = port;
const server = serve({ fetch, port }, (address) => {
  boundPort = address.port;
  consoleLogger.info("listening", { port: boundPort, admin: ADMIN_PATH });
});

const shutdown = async () => {
  server.close();
  await kobai.close();
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown().then(() => process.exit(0));
  });
}

const outcome = await kobai.migrate();
if (!outcome.ok) {
  consoleLogger.error("refusing to start", {
    reason:
      "a migration failed; serving traffic against a half-migrated schema is worse than not serving at all",
    set: outcome.set,
  });
  await shutdown();
  process.exit(1);
}

/**
 * The first Merchant, once the tables exist. Core reports what it did and this decides what
 * that means — the same division as the migration above.
 *
 * A deployment given nobody is **not** a reason to exit. It is a working deployment that
 * nobody can administer yet, and a process that died over it would look, to whatever
 * supervises this container, exactly like the failed migration that must die — while taking
 * `/health` down with it. So it boots, and says so once, naming the two variables to set,
 * because Core reports the fact and this is the half that knows where the fact comes from.
 */
const seeded = await kobai.seedInitialMerchant();
if (seeded.status !== "seeded" && seeded.status !== "already-present") {
  consoleLogger.error("this deployment has no Merchant", {
    reason: "nobody can sign in to the Admin, and nothing under /admin can be reached",
    set: "KOBAI_INITIAL_MERCHANT_EMAIL and KOBAI_INITIAL_MERCHANT_PASSWORD, then restart",
  });
}

consoleLogger.info("ready", { port: boundPort });
