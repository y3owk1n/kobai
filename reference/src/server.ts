import { serve } from "@hono/node-server";
import { consoleLogger, createKobai } from "@kobai/core";
import config from "../kobai.config.ts";

/**
 * The reference Project's entrypoint — the whole of what a Project has to write to run
 * kobai. Read env, hand it to Core, bind a port, migrate, and decide what a failure means.
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
const kobai = createKobai({ ...config, databaseUrl, logger: consoleLogger });

let boundPort = port;
const server = serve({ fetch: kobai.fetch, port }, (address) => {
  boundPort = address.port;
  consoleLogger.info("listening", { port: boundPort });
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

consoleLogger.info("ready", { port: boundPort });
