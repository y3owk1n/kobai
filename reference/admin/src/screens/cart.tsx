import { useQuery } from "@tanstack/react-query";
import { ShoppingCartIcon } from "lucide-react";
import { CartStateBadge, stateOf } from "@/components/cart-state-badge";
import { LinkButton } from "@/components/link-button";
import { Problem } from "@/components/problem";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cartReasonOf, orThrow, problemOf } from "@/lib/refusal";
import { useRouteId } from "@/lib/route";
import { useKobaiClient } from "@/lib/session";

/**
 * One Cart, opened — what is in it, whose it is, and when it lapses (spec stories 18–21).
 *
 * The mirror image of the Order screen, and the asymmetry is ADR-0009's: an Order's Line Items
 * are a **snapshot** taken at Capture, and a Cart's are **live**. So there is no title and no
 * price on a line here — a Cart's lines follow a catalog that is free to change under them, and
 * what a Shopper will pay is resolved when they buy rather than being a figure this record
 * holds. A total on this screen would be one nothing stands behind and the first thing anybody
 * would mistake for one.
 *
 * **Nothing on this screen changes anything, deliberately.** Releasing a hold by hand takes
 * stock from a Shopper who may be at their bank having already paid — ADR-0070's failure mode,
 * caused on purpose — and the sweeper already releases on expiry. kobai serves no route for it,
 * so there is no control here to serve.
 *
 * **The Cart's own query is an ordinary one**, with no `staleTime`: a Cart is the mutable half
 * of ADR-0009 and a Merchant reloading is asking kobai what it says now.
 *
 * **It is the one detail screen that names no breadcrumb, and that is a decision.** Every other
 * one calls `lib/crumb.tsx`'s `useCrumbTitle`, because the identifier in the URL is a UUID in
 * the one place a Merchant looks to find out where they are and the record has a better name —
 * an Order's number, a Product's title. A Cart has none: the identifier *is* its name, it is
 * what a Merchant would quote, and it is the whole of the authority to act on it (ADR-0071). So
 * the crumb's own fallback — the path segment — is already the right answer, and setting it to
 * the same string through a context would be ceremony.
 */
const CART = "cart";

export function CartScreen() {
  const client = useKobaiClient();
  const id = useRouteId();

  const cart = useQuery({
    queryKey: [CART, id],
    queryFn: async () =>
      orThrow(await client.GET("/admin/carts/{id}", { params: { path: { id } } })),
  });

  if (cart.isPending) return <CartLoading />;

  if (cart.isError) {
    return isNoSuchCart(cart.error) ? (
      <NoSuchCart />
    ) : (
      <Problem
        title="That Cart could not be read."
        problem={problemOf(cart.error, "kobai did not answer.")}
      />
    );
  }

  const held = cart.data;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* An `h2`: the frame renders the page's `h1` from the route, so this is the record's
            own heading under the section's rather than a second first-level one.

            It names the Cart by its identifier because a Cart has no other name — there is no
            number the way an Order has one — and because that identifier is the whole of the
            authority to act on it, which is what a Merchant looking at this screen has come
            for (ADR-0071). */}
        <h2 className="font-medium text-xl">
          Cart <code className="break-all">{held.id}</code>
        </h2>
        <CartStateBadge cart={held} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What is in it</CardTitle>
          <CardDescription>
            As the catalog describes these Variants now, not as they were when the line
            was added — a Cart's lines are live, which is the opposite of an Order's
            (ADR-0009).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {held.lineItems.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This Cart is empty. A Cart with no lines cannot be placed, and it holds no
              stock.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Quantity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {held.lineItems.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell className="font-medium">
                      <code>{line.variant.sku}</code>
                    </TableCell>
                    <TableCell>{line.quantity}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Where it stands</CardTitle>
          <CardDescription>
            A Cart's lifetime is fixed when it is created rather than extended by use, so
            the deadline below does not move when a Shopper adds something.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Shopper</span>
            {/* A reference a storefront asserted and never a credential (ADR-0020), and a
                guest is the ordinary path. */}
            <span>{held.shopper?.email ?? "guest"}</span>
          </div>
          {/* What this Cart is denominated in, and where its lines are priced (#293,
              ADR-0074). Two rows rather than one, because they are two facts that can differ:
              the currency is stamped on the Cart when its Region is set, so a Region a Merchant
              has since moved onto another currency does not reprice a Cart in flight — and a
              Merchant looking at held stock is entitled to see which of the two they are
              reading. */}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Currency</span>
            <span>{held.currency}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Region</span>
            <span>
              {held.region === null
                ? "the Store's default"
                : `${held.region.name} (${held.region.currency})`}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Started</span>
            <span>{new Date(held.createdAt).toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Last changed</span>
            <span>{new Date(held.updatedAt).toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Deadline</span>
            <span>{new Date(held.expiresAt).toLocaleString()}</span>
          </div>
          {/* The two ends a Cart can come to, said in words as well as in the badge. Neither is
              something this screen can undo, and saying so is the whole of what a Merchant
              looking at unavailable stock needs to know.

              Asked through `stateOf`, which is where "placed wins over expired" is decided, so
              that this screen does not restate a precedence the badge beside it already owns —
              a Cart that lapsed and was then bought is spent, and reading it out as expired
              here would send a Merchant looking for stock nobody is holding. */}
          {stateOf(held) === "spent" ? (
            <p className="text-muted-foreground">
              This Cart has already become an Order, so it holds nothing and can never be
              placed again. A Cart becomes exactly one Order.
            </p>
          ) : null}
          {stateOf(held) === "expired" ? (
            <p className="text-muted-foreground">
              This Cart ran out of time. Anything it was holding has gone back on the
              shelf, and it refuses every change.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The Cart, before it is there.
 *
 * Two blocks, because two cards are coming. Announced as a status so that a Merchant whose
 * screen is being read to them is told the page is working rather than left in silence.
 */
function CartLoading() {
  return (
    <div className="grid gap-6" role="status" aria-label="Reading the Cart">
      <Skeleton className="h-7 w-72" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

/**
 * An address naming a Cart this Store is not holding.
 *
 * Its own screen rather than a red box, because the action is "go back to the list" and a
 * Merchant following somebody's link has nothing else to do. Unlike an Order, a Cart really can
 * stop being there: the sweeper removes them once they have lapsed (ADR-0057), so this is as
 * likely to be an address that used to work as one that never did.
 */
function NoSuchCart() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShoppingCartIcon />
        </EmptyMedia>
        <EmptyTitle>No such Cart</EmptyTitle>
        <EmptyDescription>
          This Store is holding no Cart at that address. A Cart that has lapsed is swept
          away in time, so a link that worked yesterday may name one that is gone.
        </EmptyDescription>
      </EmptyHeader>
      <LinkButton to="/carts">Go to Carts</LinkButton>
    </Empty>
  );
}

/**
 * Whether kobai said there is no such Cart, as against anything else going wrong.
 *
 * Narrowed rather than read out of the prose, and exhaustive over `CartRefusal` — a reason added
 * to that family in Core has no arm here and reddens this build in the same commit, rather than
 * quietly showing "No such Cart" for something else (ADR-0063). Most of the arms below are
 * unreachable from this screen and are written out anyway, because what makes the guarantee work
 * is that the compiler counts them.
 */
function isNoSuchCart(thrown: unknown): boolean {
  const reason = cartReasonOf(thrown);

  switch (reason) {
    case "cart-not-found":
      return true;

    case "invalid":
    case "malformed-body":
    case "secret-key-required":
    case "cart-expired":
    case "cart-placed":
    case "line-item-not-found":
    case "variant-not-found":
    case "variant-not-priced":
    case "region-not-found":
    case "cart-is-denominated":
    case "variant-not-priced-in-region":
      // Every one of these is a refusal a **write** meets, and this Admin makes none: the Cart
      // surface it can reach is read-only (ADR-0071). If one ever arrives here it is a fact
      // about kobai rather than about the address, so it is reported as itself.
      return false;

    case undefined:
      // A 500, which carries no `reason` on purpose, a refusal from one of the gates above
      // this route, or the network being gone.
      return false;

    default: {
      // Unreachable, and it is the compiler that says so.
      const unreached: never = reason;
      return unreached;
    }
  }
}
