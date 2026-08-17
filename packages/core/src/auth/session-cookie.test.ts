import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createTestKobai, TEST_MERCHANT, type TestKobai } from "../testing/index.ts";

/**
 * Where the session cookie is actually sent, driven the way a browser drives it.
 *
 * `auth.test.ts` asserts what the `Set-Cookie` header says. This file asserts what that
 * header *does*, because the two came apart in #65: a cookie can be set successfully, on a
 * response a test reads happily, and then never be sent again. So nothing here copies a
 * header from one response into the next request. A cookie jar stores what came back and
 * decides for itself what to send, by RFC 6265's rules, and the Merchant is signed in
 * through a Core mounted where a Project would mount it — under a prefix as well as at the
 * root.
 *
 * That is the whole subject. Core hands a Project its `fetch` and binding it is the
 * Project's job (ADR-0031), so a Project is free to serve the admin surface at
 * `/api/admin`; the cookie has to arrive there, and has to be cleared there.
 */

let kobai: TestKobai | undefined;

afterEach(async () => {
  await kobai?.close();
  kobai = undefined;
});

/** Both mounts a Project can choose, run through the same tests. */
const MOUNTS = [
  ["at the root", ""],
  ["under a prefix", "/api"],
] as const;

describe("a Project mounting Core", () => {
  it.each(MOUNTS)(
    "signs a Merchant in and keeps them signed in — %s",
    async (_case, prefix) => {
      kobai = await createTestKobai();
      const browser = openBrowser(mounted(kobai, prefix));

      await browser.request(`${prefix}/admin/merchants`, signIn());
      const signedIn = await browser.request(`${prefix}/admin/session`, signIn());
      // Nothing carried across by hand: the jar sends what a browser would send, or nothing.
      const afterwards = await browser.request(`${prefix}/admin/store`);

      expect(signedIn.status).toBe(201);
      // The very next request is the one that used to be refused with a live session sitting
      // in the database, because the cookie was scoped to a path this deployment never serves.
      expect(afterwards.status).toBe(200);
    },
  );

  it.each(MOUNTS)(
    "keeps the session off the store surface and off /health — %s",
    async (_case, prefix) => {
      kobai = await createTestKobai();
      const browser = await signedIn(mounted(kobai, prefix), prefix);

      // Narrowing the cookie to the admin surface was deliberate (ADR-0032): a credential
      // that never reaches a handler is one that handler cannot log. Following the mount
      // must not widen it back out to everything the Project serves from this origin.
      // Every path here is the one this deployment actually serves them at, so that a
      // prefixed run is not asking about addresses nothing answers on.
      expect(browser.sends(`${prefix}/admin/store`)).toBe(true);
      expect(browser.sends(`${prefix}/store/variants/x/price`)).toBe(false);
      expect(browser.sends(`${prefix}/health`)).toBe(false);
      expect(browser.sends(`${prefix}/`)).toBe(false);
    },
  );

  it.each(MOUNTS)("signs the Merchant back out — %s", async (_case, prefix) => {
    kobai = await createTestKobai();
    const browser = await signedIn(mounted(kobai, prefix), prefix);

    const signedOut = await browser.request(`${prefix}/admin/session`, {
      method: "DELETE",
    });
    const afterwards = await browser.request(`${prefix}/admin/store`);

    expect(signedOut.status).toBe(204);
    expect(afterwards.status).toBe(401);
    // `session-missing` rather than `session-unknown` is the assertion that matters. Both are
    // 401 and the row is gone either way, but `unknown` would mean the browser was still
    // sending the old cookie — which is exactly what a clear that disagreed about `Path`
    // leaves behind. `missing` is the browser having actually dropped it.
    await expect(afterwards.json()).resolves.toMatchObject({ reason: "session-missing" });
    expect(browser.sends(`${prefix}/admin/store`)).toBe(false);
  });
});

/**
 * Core, mounted where a Project chose to put it.
 *
 * `mount` is how a Hono Project serves a `fetch` handler under a prefix, and it **strips
 * that prefix before Core sees the request** — Core is handed `/admin/session` whether it
 * was reached at `/admin/session` or at `/api/admin/session`. That is the crux of #65: the
 * prefix is not something Core can read off the request, so nothing here may pretend it can.
 * A reverse proxy rewriting `/api` away in front of a root-mounted Core hands Core the same
 * request, so this stands in for that deployment too.
 */
function mounted(instance: TestKobai, prefix: string): Handler {
  const project = new Hono();
  project.mount(prefix === "" ? "/" : prefix, instance.fetch);
  return project.fetch;
}

/** What a Project binds a server to, and all this file needs of one. */
type Handler = (request: Request) => Response | Promise<Response>;

/**
 * A browser that has claimed the deployment and signed in — three requests of setup in front
 * of the assertion that matters, which is why it is here rather than in each test.
 */
async function signedIn(handler: Handler, prefix: string) {
  const browser = openBrowser(handler);
  await browser.request(`${prefix}/admin/merchants`, signIn());
  const response = await browser.request(`${prefix}/admin/session`, signIn());
  if (response.status !== 201) {
    throw new Error(`signing in at ${prefix}/admin/session answered ${response.status}`);
  }
  return browser;
}

/**
 * The part of a browser this file needs: a cookie jar.
 *
 * It stores what a response set and decides what to send, rather than a test deciding —
 * which is the only way to observe a cookie that is set and then never sent again. Two rules
 * from RFC 6265 do all the work, and both are implemented here rather than assumed:
 * **default-path** (section 5.1.4), which is where a cookie carrying no `Path` is filed, and
 * **path-match** (section 5.1.4), which decides whether a stored cookie goes out with a
 * request.
 */
function openBrowser(handler: Handler) {
  const origin = "http://kobai.test";
  const jar: Jar = new Map();

  return {
    async request(path: string, init: RequestInit = {}): Promise<Response> {
      const cookie = cookieHeader(jar, path);
      const response = await handler(
        new Request(`${origin}${path}`, {
          ...init,
          headers: { ...init.headers, ...(cookie === undefined ? {} : { cookie }) },
        }),
      );

      const setCookie = response.headers.get("set-cookie");
      if (setCookie !== null) store(jar, setCookie, path);
      return response;
    },

    /** Whether the browser would attach the session to a request for `path`. */
    sends(path: string): boolean {
      return cookieHeader(jar, path) !== undefined;
    },
  };
}

type StoredCookie = {
  readonly name: string;
  readonly value: string;
  readonly path: string;
};

/** Keyed by name *and* path, which is how a browser tells two stored cookies apart. */
type Jar = Map<string, StoredCookie>;

function store(jar: Jar, setCookie: string, requestPath: string): void {
  const [pair, ...rest] = setCookie.split(";");
  const separator = pair?.indexOf("=") ?? -1;
  if (pair === undefined || separator === -1) return;

  // Attribute *names* are case-insensitive and attribute values are not — a cookie path is
  // compared byte for byte — so only the name is folded.
  const attributes = rest.map((attribute) => attribute.trim());
  const named = (name: string) =>
    attributes
      .find((attribute) => attribute.toLowerCase().startsWith(`${name}=`))
      ?.slice(name.length + 1);
  const declared = named("path");

  const cookie: StoredCookie = {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
    path: declared === undefined || declared === "" ? defaultPath(requestPath) : declared,
  };

  // `Max-Age=0` is how a cookie is deleted, and a browser matches that deletion to a stored
  // cookie by name and path like any other write. A clear filed at a different path leaves
  // the original sitting there, and sign-out only looks like it worked.
  const key = keyOf(cookie);
  if (named("max-age") === "0") jar.delete(key);
  else jar.set(key, cookie);
}

function keyOf(cookie: StoredCookie): string {
  return JSON.stringify([cookie.name, cookie.path]);
}

function cookieHeader(jar: Jar, requestUri: string): string | undefined {
  const requestPath = requestUri.split(/[?#]/)[0] ?? "";
  const sent = [...jar.values()]
    .filter((cookie) => pathMatches(cookie.path, requestPath))
    .map((cookie) => `${cookie.name}=${cookie.value}`);

  return sent.length === 0 ? undefined : sent.join("; ");
}

/**
 * RFC 6265 section 5.1.4: a cookie carrying no `Path` is filed under the directory of the
 * URI that set it. `/admin/session` files it at `/admin`; `/api/admin/session` files it at
 * `/api/admin`. The browser computes that from the URI **it** requested, which is the one
 * fact a mounted application cannot see.
 */
function defaultPath(requestUri: string): string {
  // The URI's path, so a query string is not mistaken for one more path segment.
  const uriPath = requestUri.split(/[?#]/)[0] ?? "";
  if (!uriPath.startsWith("/")) return "/";
  const lastSlash = uriPath.lastIndexOf("/");
  return lastSlash === 0 ? "/" : uriPath.slice(0, lastSlash);
}

/** RFC 6265 section 5.1.4: an exact match, or a prefix ending at a `/` boundary. */
function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

const signIn = (): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(TEST_MERCHANT),
});
