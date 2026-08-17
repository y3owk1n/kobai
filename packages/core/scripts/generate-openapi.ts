import { writeFile } from "node:fs/promises";
import { OPENAPI_DOCUMENT_PATH, openApiJson } from "../src/http/openapi.ts";
import { createKobai } from "../src/kobai.ts";

/**
 * Writes `packages/core/openapi.json` from the application itself.
 *
 * Run it with `devbox run openapi:generate`, which regenerates the description and then the
 * client that is generated from it, in that order.
 *
 * There is no database here, and there does not need to be one: `createKobai` builds its
 * connection pool without connecting, and the description is a property of the routes
 * rather than of any data behind them. That is the point — the document is taken from the
 * same `OpenAPIHono` that serves requests, so it cannot describe a surface this build does
 * not have.
 */
const kobai = createKobai({
  // Never opened. `pg.Pool` connects lazily, and nothing here makes a query.
  databaseUrl: "postgres://kobai@localhost:5432/kobai",
});

await writeFile(OPENAPI_DOCUMENT_PATH, openApiJson(kobai.openapi()), "utf8");
await kobai.close();

console.log(`wrote ${OPENAPI_DOCUMENT_PATH.pathname}`);
