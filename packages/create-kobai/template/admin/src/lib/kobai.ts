import { createKobaiClient, type KobaiClient } from "@kobai/client";

/**
 * The Admin's only door to kobai, and the only module in it that reaches the network.
 *
 * Everything the Admin can do, it does through `@kobai/client` against the public API
 * (ADR-0010). There is no privileged channel and no route reserved for this consumer: if a
 * screen here needs something, the API has to grow it in the open, where a Developer
 * building a storefront gets it too. `tests/admin-uses-only-the-public-api.test.ts` is what
 * keeps that from quietly becoming untrue — it fails the build on a `fetch` anywhere in this
 * source tree, including in this file.
 *
 * Two clients, because kobai has two surfaces and two credentials (ADR-0020):
 *
 * - the **admin** one carries nothing. The session is an httpOnly cookie the browser sends
 *   by itself on the same origin (ADR-0032), so the Admin stores no credential and models no
 *   session. `fetch` attaches same-origin cookies by default, which is the whole of the
 *   configuration.
 * - the **storefront** one carries an API key as `Authorization: Bearer …`, because that is
 *   how a storefront reaches `/store`. The Admin builds one only to answer "what price would
 *   a storefront receive", and it answers it by *being* one rather than by asking kobai for a
 *   number no storefront could get. The session cookie would not do: it is scoped to the
 *   admin surface and a browser does not send it to `/store` at all.
 *
 * Both are built against `window.location.origin`, because this Project binds Core's `fetch`
 * at the root of the origin that also serves this page (`reference/src/server.ts`). A Project
 * that mounts Core under a prefix instead serves the Admin from the same prefix, and this is
 * the one line it changes — the browser is the only party that knows what URI it asked for,
 * since Hono strips a mount prefix before Core ever sees a request.
 */

/** Why the admin gate turned a request back. The four have four different fixes. */
export type SessionEnded =
  | "session-missing"
  | "session-malformed"
  | "session-unknown"
  | "session-expired";

const SESSION_ENDED: readonly SessionEnded[] = [
  "session-missing",
  "session-malformed",
  "session-unknown",
  "session-expired",
];

/**
 * A client for the admin surface, watching for the session ending underneath it.
 *
 * Expiry is not a timer in the browser. The `kobai_session` cookie carries no `Max-Age`
 * (ADR-0032) precisely so that an expired session still *arrives* and is answered
 * `session-expired` — a distinguishable refusal rather than the silence an anonymous request
 * would get. So the Admin learns it has been signed out the way it learns anything else:
 * from a response. This middleware is on every call, so no screen can forget to check.
 */
export function createAdminClient(
  onSessionEnded: (reason: SessionEnded) => void,
): KobaiClient {
  const client = createKobaiClient({ baseUrl: window.location.origin });

  client.use({
    onResponse: async ({ response }) => {
      if (response.status !== 401) return undefined;
      const reason = await refusalReason(response);
      if (reason) onSessionEnded(reason);
      // The response itself is handed on untouched: the screen that made the call still
      // gets to say what it wanted, and this only decides that the session is over.
      return undefined;
    },
  });

  return client;
}

/**
 * A client for the store surface, carrying an API key exactly as a storefront's would.
 *
 * A publishable key belongs in a browser — that is what the `kobai_pk_` prefix means — and a
 * resolved price is what a browser may know. Nothing here would work with the Merchant's
 * session, and nothing here would be a fair demonstration if it did.
 */
export function createStorefrontClient(apiKey: string): KobaiClient {
  return createKobaiClient({ baseUrl: window.location.origin, credential: { apiKey } });
}

/**
 * The `reason` on a 401, if it is one of the admin gate's.
 *
 * The body is read from a clone, so the caller still receives an unread one — a middleware
 * that consumed the stream would break every screen it was meant to protect.
 */
async function refusalReason(response: Response): Promise<SessionEnded | undefined> {
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  if (typeof body !== "object" || body === null || !("reason" in body)) return undefined;
  return SESSION_ENDED.find((known) => known === body.reason);
}
