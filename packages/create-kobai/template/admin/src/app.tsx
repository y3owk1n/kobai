import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CompassIcon, LockIcon } from "lucide-react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AppLayout } from "@/components/app-layout";
import { LinkButton } from "@/components/link-button";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { problemOf } from "@/lib/refusal";
import { useSections } from "@/lib/sections";
import { KobaiProvider, useSession } from "@/lib/session";
import { ThemeProvider } from "@/lib/theme";
import { ApiKeys } from "@/screens/api-keys";
import { CartScreen } from "@/screens/cart";
import { Carts } from "@/screens/carts";
import { CollectionScreen } from "@/screens/collection";
import { Collections } from "@/screens/collections";
import { DeploymentScreen } from "@/screens/deployment";
import { MediaScreen } from "@/screens/media";
import { Merchants } from "@/screens/merchants";
import { OrderScreen } from "@/screens/order";
import { Orders } from "@/screens/orders";
import { Playground } from "@/screens/playground";
import { ProductScreen } from "@/screens/product";
import { Products } from "@/screens/products";
import { RoleScreen } from "@/screens/role";
import { Roles } from "@/screens/roles";
import { SignIn } from "@/screens/sign-in";
import { StoreScreen } from "@/screens/store";

/**
 * The Admin, whole.
 *
 * It holds no credential and models no session. `GET /admin/session` is the first call after
 * a page load — "who am I, and what may I do" — and the browser answers the "am I signed in"
 * part by sending the cookie or not sending it (ADR-0032). Signing out is
 * `DELETE /admin/session`, which deletes the row *and* clears the cookie, so neither half is
 * left behind. Both of those live in `lib/session.tsx`; this file is the frame around them.
 *
 * **There is a router, and every screen has a URL** (ADR-0063). The Admin held its screen in
 * `useState` until #174, which was honest at four screens and made every one of them
 * unlinkable — a Merchant could not send "look at this Order" as anything but instructions,
 * and a refresh always landed back on Products. The server half of this has been in place the
 * whole time: `reference/src/admin-assets.ts` hands back `index.html` for every unmatched path
 * under `/admin-ui/` and lets the page read the URL. This is the page reading it.
 *
 * **Every route below is the screen itself**, with no adapter in between. Four of them were
 * wrapped until #176, in shims that pulled the client and a back-navigation callback out of
 * context and handed them down as props — the shape those screens had before there was a
 * router. Each of them now reads what it needs from the router and from `useKobaiClient`, the
 * way the Products screen has since #174, so a route in this file is a path and a component
 * and nothing else.
 */
const ADMIN_BASE = import.meta.env.BASE_URL.replace(/\/+$/, "") || "/";

/**
 * The cache every screen reads through.
 *
 * Built once, at module scope, because a client rebuilt on a render would throw its cache away
 * on each one. Two defaults are worth stating rather than inheriting:
 *
 * - **Nothing is retried.** A refusal is an answer, not a hiccup: retrying a 403 three times
 *   delays telling a Merchant something kobai already said, and each retry is another request
 *   against a Store. What is worth retrying is the network being briefly gone, and a Merchant
 *   reloading is a fine way to say so.
 * - **No optimistic updates, anywhere** — that one is not a default but a rule (ADR-0063), and
 *   it is kept by every mutation invalidating and none of them writing to the cache. What a
 *   record looks like once kobai has it is kobai's answer.
 */
const queries = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queries}>
        <KobaiProvider>
          <TooltipProvider>
            <BrowserRouter basename={ADMIN_BASE}>
              <Admin />
            </BrowserRouter>
          </TooltipProvider>
        </KobaiProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

/**
 * Signed in, or not, or still asking.
 *
 * The sign-in screen is rendered **in place of the routes rather than at a route of its own**,
 * so the URL is untouched while it is up: a Merchant whose session expired on an Order signs in
 * and is looking at that Order again, with no return path to remember anywhere. #175 is where
 * that is asserted in a browser.
 */
function Admin() {
  const session = useSession();

  if (session.isPending) return <AskingWhoYouAre />;

  if (session.isError) {
    // Distinct from "you are not signed in", which is an ordinary 401 and answers `null`.
    // Getting here means kobai did not answer at all, and a sign-in form would be a lie about
    // what is wrong.
    return (
      <main className="mx-auto grid max-w-sm gap-3 p-6">
        {/* Rendered in place of the frame, like the sign-in screen and the gate above, so
            there is no `h1` above it to inherit. */}
        <h1 className="sr-only">The kobai Admin could not reach kobai</h1>
        <Problem
          title="kobai did not answer."
          problem={problemOf(session.error, "The Admin could not reach kobai.")}
        />
        <Button onClick={() => void session.refetch()}>Try again</Button>
      </main>
    );
  }

  if (!session.data) return <SignIn />;

  return (
    <Routes>
      <Route element={<AppLayout session={session.data} />}>
        <Route index element={<FrontDoor />} />
        <Route path="products" element={<Products />} />
        <Route path="products/:id" element={<ProductScreen />} />
        <Route path="media" element={<MediaScreen />} />
        <Route path="collections" element={<Collections />} />
        <Route path="collections/:id" element={<CollectionScreen />} />
        <Route path="orders" element={<Orders />} />
        <Route path="orders/:id" element={<OrderScreen />} />
        <Route path="carts" element={<Carts />} />
        <Route path="carts/:id" element={<CartScreen />} />
        {/* Under `developer/` since #266, and **nothing answers `api-keys` any more**: the
            address is what a Merchant sends a colleague and what a refresh lands on, so it is
            where the grouping is true if it is true anywhere, and a redirect from the old one
            would be permanent furniture in vendored source `kobai-upgrade` can never reach.
            kobai is not published, so there is no bookmark to preserve (ADR-0079). */}
        <Route path="developer/api-keys" element={<ApiKeys />} />
        {/* Three reads composed into one answer, and no fourth route to serve it
            (ADR-0080). It joins the group API keys was moved into rather than standing
            beside it, because what it answers is the deployment rather than the Store. */}
        <Route path="developer/deployment" element={<DeploymentScreen />} />
        {/* The description, browsed (#268). The chosen operation is a search parameter rather
            than a segment, so the address can hold a path with slashes in it without the
            router having to — and so that #269's parameters and body join it in the same
            place, which is where this frame already keeps a cursor and every filter
            (ADR-0064). */}
        <Route path="developer/playground" element={<Playground />} />
        <Route path="merchants" element={<Merchants />} />
        <Route path="roles" element={<Roles />} />
        <Route path="roles/:id" element={<RoleScreen />} />
        {/* Not `store`: a quoted path in this tree beginning with admin, store or health is
            read as a kobai path by `tests/admin-uses-only-the-public-api.test.ts`, which is
            how ADR-0010's promise is kept by the build — so the Admin's own addresses have to
            stay out of kobai's namespace. `lib/sections.ts` carries the whole of that
            reasoning, and the check caught this very comment when it named the address
            outright. */}
        <Route path="settings" element={<StoreScreen />} />
        <Route path="*" element={<NoSuchScreen />} />
      </Route>
    </Routes>
  );
}

/**
 * The first moment of every page load: the session query in flight.
 *
 * It is a whole screen rather than a spinner inside the frame, because which frame to draw is
 * exactly what is not known yet — the sidebar belongs to a Merchant and there may not be one.
 * So it renders in place of the routes, like the sign-in screen, and like it carries its own
 * `h1`: a page whose only content is a status message is still a page, and one with no
 * first-level heading is one a screen reader cannot summarise.
 */
function AskingWhoYouAre() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-2 p-6 text-muted-foreground text-sm">
      <h1 className="sr-only">Opening the kobai Admin</h1>
      <p className="flex items-center gap-2">
        <Spinner />
        Asking kobai who you are…
      </p>
    </main>
  );
}

/**
 * Where `/admin-ui/` itself lands: the first section this Role can read.
 *
 * Products is still the front door for everybody who can read the catalog, which is every Role
 * kobai seeds. It stopped being unconditional with #178: a Role without `catalog:read` sent to
 * the Products list would meet a refusal on the one address it did not choose, which is exactly
 * the empty-screen-that-403s ADR-0063 hides a section to avoid. So the front door is the head
 * of the list the sidebar draws, and the two cannot disagree because they are one list.
 *
 * `replace` keeps `/admin-ui/` out of the history, so the back button leaves the Admin rather
 * than bouncing off the redirect.
 */
function FrontDoor() {
  const first = useSections()[0];
  return first ? <Navigate to={first.path} replace /> : <NothingToShow />;
}

/**
 * A Role that can read nothing at all.
 *
 * Not a contrived state: `POST /admin/roles` creates a Role with no Permissions by default, so
 * this is what a colleague sees between being added and being told what they may do. The Admin
 * has nowhere to send them and says so, rather than drawing an empty frame that looks like a
 * list still loading.
 *
 * It offers no way out on purpose — there is nowhere to go — and no way to ask, because who
 * administers access is not something this browser knows.
 */
function NothingToShow() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LockIcon />
        </EmptyMedia>
        <EmptyTitle>This Admin has nothing to show you</EmptyTitle>
        <EmptyDescription>
          Your Role holds none of the permissions this Admin's screens need. A Merchant
          who administers access can add them, and this screen will fill in the moment
          they do.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * A URL under `/admin-ui/` that no screen answers.
 *
 * The Project serves `index.html` for every path under the Admin's, so a mistyped one arrives
 * here rather than at a 404 from the server — which is what makes deep links work at all. What
 * it must not do is show an empty frame and leave a Merchant wondering whether it is loading.
 */
function NoSuchScreen() {
  // The way out is the first section this Role can read, and not `/products`, which it was
  // until #178: on a Role without `catalog:read` that was a mistyped address answered with a
  // link to a refusal. A Role that can read nothing is offered no way out at all, because
  // there is nowhere to send them.
  const first = useSections()[0];

  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CompassIcon />
        </EmptyMedia>
        <EmptyTitle>No such screen</EmptyTitle>
        <EmptyDescription>
          Nothing in this Admin answers that address.
          {first ? ` The ${first.label} list is a good place to start.` : null}
        </EmptyDescription>
      </EmptyHeader>
      {first ? <LinkButton to={first.path}>Go to {first.label}</LinkButton> : null}
    </Empty>
  );
}
