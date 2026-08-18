import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CompassIcon } from "lucide-react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router";
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
import { KobaiProvider, useKobai, useKobaiClient, useSession } from "@/lib/session";
import { ThemeProvider } from "@/lib/theme";
import { ApiKeys } from "@/screens/api-keys";
import { OrderScreen } from "@/screens/order";
import { Orders } from "@/screens/orders";
import { ProductScreen } from "@/screens/product";
import { Products } from "@/screens/products";
import { SignIn } from "@/screens/sign-in";

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
  const client = useKobaiClient();
  const { expired, signedIn } = useKobai();

  if (session.isPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center gap-2 text-muted-foreground text-sm">
        <Spinner />
        Asking kobai who you are…
      </main>
    );
  }

  if (session.isError) {
    // Distinct from "you are not signed in", which is an ordinary 401 and answers `null`.
    // Getting here means kobai did not answer at all, and a sign-in form would be a lie about
    // what is wrong.
    return (
      <main className="mx-auto grid max-w-sm gap-3 p-6">
        <Problem
          title="kobai did not answer."
          problem={problemOf(session.error, "The Admin could not reach kobai.")}
        />
        <Button onClick={() => void session.refetch()}>Try again</Button>
      </main>
    );
  }

  if (!session.data) {
    return <SignIn client={client} expired={expired} onSignedIn={signedIn} />;
  }

  return (
    <Routes>
      <Route element={<AppLayout session={session.data} />}>
        {/* Products is the Admin's front door, and `replace` keeps `/admin-ui/` out of the
            history so the back button leaves rather than bouncing. */}
        <Route index element={<Navigate to="/products" replace />} />
        <Route path="products" element={<Products />} />
        <Route path="products/:id" element={<ProductRoute />} />
        <Route path="orders" element={<OrdersRoute />} />
        <Route path="orders/:id" element={<OrderRoute />} />
        <Route path="api-keys" element={<ApiKeysRoute />} />
        <Route path="*" element={<NoSuchScreen />} />
      </Route>
    </Routes>
  );
}

/**
 * The four screens the frame carries but did not rewrite, each behind a route.
 *
 * They still take a client and a callback, which is the shape they had before there was a
 * router — so these adapt the route to them rather than the other way round. Moving each onto
 * TanStack Query, on the conventions Products now sets, is #176's whole ticket; doing it here
 * would have been the same work in a commit that could not be reviewed for it.
 */
function ProductRoute() {
  const client = useKobaiClient();
  const navigate = useNavigate();
  const { id } = useParams();

  if (id === undefined) return <Navigate to="/products" replace />;

  return (
    <ProductScreen
      client={client}
      id={id}
      onBack={() => {
        void navigate("/products");
      }}
    />
  );
}

function OrdersRoute() {
  const client = useKobaiClient();
  const navigate = useNavigate();

  return (
    <Orders
      client={client}
      onOpen={(id) => {
        void navigate(`/orders/${id}`);
      }}
    />
  );
}

function OrderRoute() {
  const client = useKobaiClient();
  const navigate = useNavigate();
  const { id } = useParams();

  if (id === undefined) return <Navigate to="/orders" replace />;

  return (
    <OrderScreen
      client={client}
      id={id}
      onBack={() => {
        void navigate("/orders");
      }}
    />
  );
}

function ApiKeysRoute() {
  const client = useKobaiClient();
  return <ApiKeys client={client} />;
}

/**
 * A URL under `/admin-ui/` that no screen answers.
 *
 * The Project serves `index.html` for every path under the Admin's, so a mistyped one arrives
 * here rather than at a 404 from the server — which is what makes deep links work at all. What
 * it must not do is show an empty frame and leave a Merchant wondering whether it is loading.
 */
function NoSuchScreen() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CompassIcon />
        </EmptyMedia>
        <EmptyTitle>No such screen</EmptyTitle>
        <EmptyDescription>
          Nothing in this Admin answers that address. The Products list is a good place to
          start.
        </EmptyDescription>
      </EmptyHeader>
      <LinkButton to="/products">Go to Products</LinkButton>
    </Empty>
  );
}
