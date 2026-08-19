import type { AdminAssets } from "./admin-assets.ts";
import type { RedirectPaymentRoutes } from "./payments/redirect.ts";

/**
 * One origin, three things served from it: the Admin's files, this Project's redirect payment
 * flow, and kobai.
 *
 * This is the whole of ADR-0010's "one thing to deploy". There is no proxy, no second
 * process and no second origin, so there is no CORS to configure — and nothing in this
 * repository configures any. The Admin's calls are same-origin, which is also what lets the
 * Merchant's session travel as a cookie the browser attaches by itself (ADR-0032).
 *
 * The routing is a question per thing this Project serves, asked in order: is this path the
 * Admin's, is it the redirect flow's? Everything else goes to kobai untouched — including
 * paths kobai does not serve, so a 404 under `/admin` is *its* 404 and not a decision this
 * file made. That is the shape the "no private back door" promise needs: **this Project adds
 * no route to the API**, so there is no route only the Admin could call, and
 * `reference/src/app.test.ts` asserts exactly that.
 *
 * **The redirect routes are not an exception to it and could not be.** They sit at
 * `/payments/…`, off kobai's two surfaces entirely, and they reach kobai the way any other
 * client does: over `/store`, with a secret API key, through the same `POST /store/orders`
 * every storefront calls (ADR-0070). A Plugin could not have added them — routes are not one
 * of ADR-0003's five Extension Points — and here that is the right shape rather than a limit,
 * because whatever a bank does that nobody anticipated is the deployment's to own.
 */
export type ProjectFetch = (request: Request) => Response | Promise<Response>;

export function createProjectFetch(
  kobai: { readonly fetch: ProjectFetch },
  admin: AdminAssets,
  /**
   * How this deployment takes payments a Shopper completes at their bank — absent on one that
   * takes none, which is a working Project rather than a broken one.
   *
   * The same judgement Core makes about a deployment with no Payment Provider (ADR-0053): it
   * boots, it serves its catalog, and the thing it cannot do refuses when it is asked. Nothing
   * is mounted here for a deployment that has no bank to redirect to, so there is no route
   * standing ready to answer for a provider that does not exist.
   */
  payments?: RedirectPaymentRoutes,
): ProjectFetch {
  return (request) => {
    const { pathname } = new URL(request.url);
    if (admin.claims(pathname)) return admin.fetch(request);
    if (payments?.claims(pathname)) return payments.fetch(request);
    return kobai.fetch(request);
  };
}
