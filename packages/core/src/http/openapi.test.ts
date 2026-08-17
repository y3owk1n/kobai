import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createMigrationStateHolder } from "../migrations/state.ts";
import { priceResolutionWorkflow } from "../pricing/resolve-price.ts";
import { silentLogger } from "../testing/kobai.ts";
import { createHttpApp, describeHttpApp } from "./app.ts";
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
    // Core's own, rather than a Project's rewiring of it. A replaced Step changes which
    // Step runs and never which routes exist, so the description does not move with it —
    // and a test that boots a Project's config to assert that would be asserting nothing.
    priceWorkflow: priceResolutionWorkflow,
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
function servedOperations(routes: readonly { method: string; path: string }[]): string[] {
  const served = routes
    // `ALL` is what a wildcard mount registers as, and there are exactly two: `/admin/*`
    // and `/store/*`, carrying the migration gate, the two credential gates, and the store
    // surface's own JSON 404. None of them is a path a caller asks for by name, and a
    // description enumerates paths, so none belongs in one.
    .filter((route) => route.method !== "ALL")
    .map(
      (route) => `${route.method.toLowerCase()} ${route.path.replace(/:(\w+)/g, "{$1}")}`,
    );

  return [...new Set(served)].sort();
}

/** Every HTTP method OpenAPI lets a path item carry — everything else on one is metadata. */
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function documentedOperations(paths: Record<string, object>): string[] {
  return Object.entries(paths)
    .flatMap(([path, item]) =>
      Object.keys(item)
        .filter((key) => METHODS.includes(key))
        .map((method) => `${method} ${path}`),
    )
    .sort();
}

describe("the description is generated from the routes", () => {
  it("describes every route the router serves, and no route it does not", () => {
    const { app, document } = describeCore();

    expect(documentedOperations(document.paths ?? {})).toEqual(
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
 * Which scheme an operation must name, from where it sits.
 *
 * Two operations name none, and both are named here rather than inferred from the absence:
 * `/health` is open on purpose, and `POST /admin/session` is what *mints* a session, so
 * requiring one would leave nobody able to obtain the first. Everything else is behind its
 * surface's gate — including `POST /admin/merchants`, which is reachable anonymously on a
 * deployment nobody has claimed and still names the scheme it needs on every other one.
 */
function expectedSchemes(operation: string): string[] {
  if (operation === "get /health" || operation === "post /admin/session") return [];
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
    const { document } = describeCore();

    // Per operation rather than per surface: a union over `/admin` would stay unchanged
    // when one guarded route simply forgot to name its scheme, and that omission is
    // exactly the mistake worth catching on a surface that is closed by default.
    const schemes = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(item as Record<string, { security?: object[] }>)
        .filter(([method]) => METHODS.includes(method))
        .map(([method, operation]) => ({
          operation: `${method} ${path}`,
          named: (operation.security ?? []).flatMap((requirement) =>
            Object.keys(requirement),
          ),
        })),
    );

    for (const { operation, named } of schemes) {
      expect(named, operation).toEqual(expectedSchemes(operation));
    }

    // The loop is only worth anything if it found the operations. A scan that silently
    // found none would pass every assertion in it.
    expect(schemes).toHaveLength(13);
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
