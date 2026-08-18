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
 * They were two schemes when both were `Authorization: Bearer`, because they open two
 * different surfaces and neither credential is worth anything on the other (ADR-0020) — a
 * generated client that treated them as one would let a storefront's key be sent at
 * `/admin` and call it a type-correct request. Since ADR-0032 they do not even arrive the
 * same way: the admin surface is opened by the `kobai_session` cookie and the store
 * surface by a bearer API key.
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
 * A refusal from the **store** gate, which is a JSON body *and* a header.
 *
 * RFC 6750 says a 401 names the scheme the request failed to satisfy, and the store gate
 * sends it. Describing it as a header rather than only mentioning it in prose is the
 * difference between a client that can act on it and a Developer who has to read the
 * sentence.
 *
 * The admin gate no longer has one to send. `/admin` is opened by the `kobai_session`
 * cookie (ADR-0032), and there is no registered HTTP authentication scheme for a cookie —
 * so a challenge there would either name `Bearer`, which is now false, or invent a scheme
 * no client knows. Its 401 is a plain body, and `SessionRefusal`'s `reason` is what a
 * client acts on.
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
  noSession: json(
    "No live Merchant session was presented — the `kobai_session` cookie was absent, unusable, unknown or expired.",
    contract.SessionRefusal,
  ),
  noApiKey: unauthorised("No live API key was presented.", contract.ApiKeyRefusal),
  forbidden: json(
    "The Merchant's Role does not hold the permission this route requires.",
    contract.PermissionDenied,
  ),
  secretKeyRequired: json(
    "The API key is live and publishable, and this route requires a secret one.",
    contract.SecretKeyRequired,
  ),
  // Only for a route with nothing else to refuse at 400. A route whose handler can also turn a
  // well-formed body back — a Merchant's address already taken, a SKU already carried —
  // declares its family's schema instead, because `refused` answers with one body type across
  // every status the route names (ADR-0060).
  invalid: json(
    "The request does not fit this endpoint's schema, or is not JSON at all.",
    contract.InvalidRequest,
  ),
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
