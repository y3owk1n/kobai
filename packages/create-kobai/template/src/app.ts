import type { AdminAssets } from "./admin-assets.ts";

/**
 * One origin, two things served from it: the Admin's files, and kobai.
 *
 * This is the whole of ADR-0010's "one thing to deploy". There is no proxy, no second
 * process and no second origin, so there is no CORS to configure — and nothing in this
 * repository configures any. The Admin's calls are same-origin, which is also what lets the
 * Merchant's session travel as a cookie the browser attaches by itself (ADR-0032).
 *
 * The routing is one question, asked once: is this path the Admin's? Everything else goes to
 * kobai untouched — including paths kobai does not serve, so a 404 under `/admin` is *its*
 * 404 and not a decision this file made. That is the shape the "no private back door"
 * promise needs: this Project adds no route to the API, so there is no route only the Admin
 * could call, and `reference/src/app.test.ts` asserts exactly that.
 */
export type ProjectFetch = (request: Request) => Response | Promise<Response>;

export function createProjectFetch(
  kobai: { readonly fetch: ProjectFetch },
  admin: AdminAssets,
): ProjectFetch {
  return (request) => {
    const { pathname } = new URL(request.url);
    return admin.claims(pathname) ? admin.fetch(request) : kobai.fetch(request);
  };
}
