import type { KobaiClient, Session } from "@kobai/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation } from "react-router";
import { createAdminClient } from "@/lib/kobai";
import { clearPreviewKey } from "@/lib/preview-key";

/**
 * Who the Merchant is, and the one client every screen reaches kobai through.
 *
 * The two are one module because they are one mechanism. The Admin holds no credential and
 * models no session (ADR-0032): the browser sends the `kobai_session` cookie or it does not,
 * and `GET /admin/session` is how the Admin finds out which. So "am I signed in" is not state
 * this application maintains — it is **a cached response**, which is exactly what TanStack
 * Query is for, and being signed out is that response going away.
 *
 * What could not be a query is the *reason* it went away. An expired session and an absent one
 * are both a 401 and both leave the same empty cache, and only the first is worth mentioning
 * to a Merchant — so the client's middleware records which it was on the way past, and the
 * sign-in screen reads it from here.
 */
const SESSION = ["session"] as const;

type Kobai = {
  /** The one client. Built once, with the 401 watcher already on it. */
  readonly client: KobaiClient;
  /** The last session ended by running out, rather than by never having existed. */
  readonly expired: boolean;
  /** Take a fresh sign-in as the answer to "who am I", without asking again. */
  readonly signedIn: (session: Session) => void;
  readonly signOut: () => Promise<void>;
};

const KobaiContext = createContext<Kobai | null>(null);

export function KobaiProvider({ children }: { readonly children: ReactNode }) {
  const queries = useQueryClient();
  const [expired, setExpired] = useState(false);

  const client = useMemo(
    () =>
      createAdminClient((reason) => {
        // Whatever call met the 401 — a list, a mutation, the session check itself — the
        // session is over, so the cached answer to "who am I" is wrong now rather than stale.
        // Writing `null` rather than invalidating is deliberate: an invalidation would refetch
        // a route that has just refused, and the gate would flicker through "asking" on the
        // way to the sign-in screen it is already sure of.
        queries.setQueryData(SESSION, null);
        // Only an expiry is worth mentioning. `session-missing` is what an anonymous page
        // load answers, and telling somebody their session ended when they never had one
        // would be noise on the very first request the Admin makes.
        setExpired(reason === "session-expired");
      }),
    [queries],
  );

  const signedIn = useCallback(
    (session: Session) => {
      queries.setQueryData(SESSION, session);
      setExpired(false);
    },
    [queries],
  );

  const signOut = useCallback(async () => {
    await client.DELETE("/admin/session");
    clearPreviewKey();
    setExpired(false);
    // This is the line that signs the Admin out on screen: the gate reads this query, and
    // writing `null` over it is what flips it. Written rather than invalidated, so signing
    // out costs the one request that actually ends the session.
    queries.setQueryData(SESSION, null);
    // Then everything *else*, because it was all read with a credential that no longer
    // exists and the next Merchant to sign in at this browser is not necessarily this one.
    //
    // Dropped one by one rather than with `clear()`, and the difference is not cosmetic:
    // `clear()` destroys the query a mounted `useQuery` is attached to, and the observer goes
    // on holding what it last read — so clearing the session query is the one thing that
    // leaves the Admin looking signed in while the cookie is gone. Watched happening, in a
    // browser, before it was written this way.
    queries.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION[0] });
  }, [client, queries]);

  const value = useMemo<Kobai>(
    () => ({ client, expired, signedIn, signOut }),
    [client, expired, signedIn, signOut],
  );

  return <KobaiContext value={value}>{children}</KobaiContext>;
}

export function useKobai(): Kobai {
  const kobai = use(KobaiContext);
  if (!kobai) throw new Error("useKobai is only usable inside a KobaiProvider.");
  return kobai;
}

/** The client, for the screens that only want to ask kobai something. */
export function useKobaiClient(): KobaiClient {
  return useKobai().client;
}

/**
 * Who the caller is, and what they may do — the Admin's first call after a page load.
 *
 * `null` is "nobody", and it is a value rather than an error: an anonymous page load is the
 * ordinary case, and the 401 that answers it is not a failure of this query. Anything else
 * that went wrong is left as an error, so the gate can tell "kobai says you are not signed in"
 * from "kobai did not answer".
 *
 * **Never cached as fresh**, so it is re-read on every window focus — and on every navigation,
 * through {@link useSessionOnNavigation}. A Role edited under a live session otherwise leaves
 * the Admin confidently wrong about what this Merchant may do (ADR-0063), and `role.permissions`
 * is already on every response. Both halves are the *affordances* catching up rather than a
 * check being re-run: the enforcement is Core's, and `lib/permissions.ts` says so at length.
 */
export function useSession() {
  const client = useKobaiClient();

  return useQuery({
    queryKey: SESSION,
    queryFn: async (): Promise<Session | null> => {
      const { data } = await client.GET("/admin/session");
      return data ?? null;
    },
    staleTime: 0,
    // Said rather than inherited. It is TanStack Query's default, but half of ADR-0063's
    // re-read rests on it — and `app.tsx` sets `defaultOptions` for this cache, so a later
    // line there could turn it off and take the focus half of this with it silently.
    refetchOnWindowFocus: true,
  });
}

/**
 * Re-reads who you are whenever the address changes — ADR-0063's other half.
 *
 * Window focus is the query's own doing, because nothing is ever cached as fresh. A navigation
 * is not: the query is observed by the gate in `app.tsx` and by the frame around every screen,
 * neither of which unmounts, so a route change is not an event TanStack Query sees. Hence an
 * explicit one, called once by `AppLayout`.
 *
 * Two details are deliberate. The **first render is not a navigation** — the gate has just
 * fetched this — so it is skipped rather than spending a second request on every page load. And
 * `cancelRefetch: false` is what keeps a navigation to one request: a screen that reads
 * permissions mounts a fresh observer of a query that is never fresh, which starts a fetch of
 * its own, and invalidating with the default would cancel that one and start another.
 */
export function useSessionOnNavigation(): void {
  const queries = useQueryClient();
  const { pathname } = useLocation();
  const previous = useRef(pathname);

  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    void queries.invalidateQueries({ queryKey: SESSION }, { cancelRefetch: false });
  }, [pathname, queries]);
}
