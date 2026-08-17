import type { OpenAPIHono, RouteConfig, z } from "@hono/zod-openapi";
import type { Context, Env } from "hono";
import * as contract from "./contract.ts";

/**
 * The OpenAPI description, and the pieces every route is declared with.
 *
 * Nothing here writes a description of kobai. The description is *produced* — from the
 * route objects the application is actually built from, by
 * `OpenAPIHono.getOpenAPI31Document`. This module only supplies the two things a route
 * cannot carry on its own: the document's own metadata, and the names of the two
 * authentication schemes a route refers to.
 *
 * The document is generated at build time and checked in
 * (`packages/core/openapi.json`), never served: `/store` deliberately refuses an
 * unauthenticated request *before* saying whether a path exists, and an endpoint that
 * handed out the whole surface anonymously would undo that. A Developer gets the
 * description from the package, and a TypeScript one gets `@kobai/client`, which is
 * generated from it.
 */

/** What `getOpenAPI31Document` hands back. Named so callers need not spell it. */
export type OpenApiDocument = ReturnType<OpenAPIHono["getOpenAPI31Document"]>;

/**
 * Where the generated description lives, resolved relative to this module's *built*
 * output — which is the package root, the same trick each migration set uses to find its
 * SQL. So it is right in the source tree, right in `dist`, and right in the tarball a
 * Project installs, without any of the three knowing about the others.
 */
export const OPENAPI_DOCUMENT_PATH = new URL("../../openapi.json", import.meta.url);

/**
 * The description as bytes.
 *
 * Two spaces and a trailing newline, because this file is checked in and diffed: a
 * formatting choice that varied would make every regeneration look like a change to the
 * API.
 */
export function openApiJson(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * The two ways in, as OpenAPI names them.
 *
 * Both are `Authorization: Bearer`, and they are nonetheless two schemes rather than one,
 * because they open two different surfaces and neither credential is worth anything on
 * the other (ADR-0020). A generated client that treated them as one scheme would let a
 * storefront's key be sent at `/admin` and call it a type-correct request.
 */
export const SECURITY_SCHEMES = {
  merchantSession: "merchantSession",
  apiKey: "apiKey",
} as const;

/** Declared on every route behind the admin gate. */
export const MERCHANT_SESSION: RouteConfig["security"] = [
  { [SECURITY_SCHEMES.merchantSession]: [] },
];

/** Declared on every route behind the store gate. */
export const API_KEY: RouteConfig["security"] = [{ [SECURITY_SCHEMES.apiKey]: [] }];

/**
 * Declared on the one route that is reachable both ways.
 *
 * `POST /admin/merchants` mints the *first* Merchant on a deployment nobody has claimed,
 * and needs `merchant:write` on every deployment after that. The empty requirement is
 * OpenAPI's way of saying the anonymous call is a real, supported one rather than an
 * oversight.
 */
export const OPTIONAL_MERCHANT_SESSION: RouteConfig["security"] = [
  {},
  { [SECURITY_SCHEMES.merchantSession]: [] },
];

/**
 * A JSON response, as a route declares one.
 *
 * The schema is carried through unwidened, which is the whole point: the handler's
 * `c.json(body, status)` is typed against exactly this schema, so a response the
 * description promises and the code does not produce is a build failure.
 */
export function json<Schema extends z.ZodType>(description: string, schema: Schema) {
  return { description, content: { "application/json": { schema } } } as const;
}

/**
 * A refusal from one of the two gates, which is a JSON body *and* a header.
 *
 * RFC 6750 says a 401 names the scheme the request failed to satisfy, and both gates send
 * it. Describing it as a header rather than only mentioning it in prose is the difference
 * between a client that can act on it and a Developer who has to read the sentence.
 */
function unauthorised<Schema extends z.ZodType>(description: string, schema: Schema) {
  return {
    ...json(description, schema),
    headers: contract.BearerChallenge,
  } as const;
}

/**
 * The refusals that belong to no single route, because they are made above every one of
 * them: the migration gate, the two credential gates, the permission check, and the
 * catch-all that turns an unhandled throw into one JSON body.
 *
 * They are spelled per route rather than merged in afterwards, so the description of a
 * route is the whole truth about it and a client generated from it can narrow on
 * `reason` without a special case.
 */
export const REFUSALS = {
  unavailable: json(
    "Migrations have not applied, so nothing but `/health` is served yet.",
    contract.Unavailable,
  ),
  noSession: unauthorised(
    "No live Merchant session was presented.",
    contract.SessionRefusal,
  ),
  noApiKey: unauthorised("No live API key was presented.", contract.ApiKeyRefusal),
  forbidden: json(
    "The Merchant's Role does not hold the permission this route requires.",
    contract.PermissionDenied,
  ),
  invalid: json("The request does not fit this endpoint's schema.", contract.Refusal),
  serverError: json("Something failed inside kobai.", contract.ServerError),
} as const;

/**
 * What a request that does not fit its schema is answered with.
 *
 * The same `{ error, reason }` every other kobai refusal uses, at 400 — a client parses a
 * schema failure exactly as it parses a Merchant's Role being too narrow or a SKU already
 * being taken. `reason` is `invalid`, which is what the modules below already answer with
 * for a request they cannot use, so a client branching on it needs to know nothing about
 * where in the stack the request was turned back.
 *
 * The issues are joined into `error` rather than reported as a structured list. A list
 * would be a second response shape for clients to handle, and this surface has one.
 */
export function invalidRequestHook<E extends Env>(
  result:
    | { readonly success: true }
    | { readonly success: false; readonly error: z.ZodError },
  c: Context<E>,
): Response | undefined {
  if (result.success) return undefined;

  const detail = result.error.issues
    .map((issue) => {
      const at = issue.path.join(".");
      return at === "" ? issue.message : `\`${at}\`: ${issue.message}`;
    })
    .join("; ");

  return c.json(
    {
      error: detail === "" ? "The request body is not usable." : detail,
      reason: "invalid",
    },
    400,
  );
}
