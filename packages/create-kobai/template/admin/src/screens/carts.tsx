import type { CartState } from "@kobai/client";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ShoppingCartIcon } from "lucide-react";
import { CartStateBadge } from "@/components/cart-state-badge";
import { LinkButton } from "@/components/link-button";
import { ListFilter, useListFilter } from "@/components/list-filter";
import { Pager, usePageCursor } from "@/components/pager";
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
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { orThrow, problemOf } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/**
 * The Carts this Store is holding (spec stories 18–21), a page at a time.
 *
 * The list a Merchant opens to answer *why is that stock unavailable?* Once a storefront holds a
 * Cart's stock before sending a Shopper to their bank (ADR-0070) the answer is usually a live
 * Cart belonging to somebody who is mid-payment, and until this screen existed the only way to
 * ask was curl.
 *
 * **Every row carries the identifier, and that is the point rather than an oversight.** A Cart
 * has no Shopper session, so its identifier is the whole of the authority to act on it — and
 * ADR-0071 amends the rule that used to forbid enumerating them to *a Cart identifier is a
 * capability Merchants hold and the public does not*. This screen is behind a Merchant session
 * and `cart:read`, which is what makes that true.
 *
 * **Read-only, and there is nothing here to click that changes anything.** Releasing a hold by
 * hand takes stock from a Shopper who may have already paid at their bank, and the sweeper
 * already releases on expiry — so kobai serves no route to do it and this screen offers no
 * control for one.
 */
const CARTS = "carts";

/**
 * The states this list can be narrowed to, with what each is called on screen.
 *
 * A `Record` keyed by `CartState` rather than an array of strings, for `lib/refusal.ts`'s
 * reason one noun along: the set is **closed** in kobai's types, so a fourth state added in Core
 * has no key here, does not compile, and reddens the Admin in the same commit (ADR-0063). What
 * this Admin may hold is what kobai's types close; what a deployment decides it must ask about.
 *
 * The order is the order they are offered in, and it is the life of a Cart: live first, because
 * that is the one worth looking at.
 */
const STATES: Record<CartState, string> = {
  live: "Live",
  expired: "Expired",
  spent: "Spent",
};

/**
 * The three, in the order they are offered.
 *
 * `Object.keys` answers `string[]` whatever it was given, so the union is put back here — the
 * one place this module says a word about types that the compiler took no part in, and the
 * reason it is safe is that the keys of a `Record<CartState, …>` are exactly the three.
 */
const OFFERED = Object.keys(STATES) as readonly CartState[];

/** The three as a list, which is the shape `components/list-filter.tsx` takes. */
const OPTIONS = OFFERED.map((state) => ({ value: state, label: STATES[state] }));

/** The query parameter the filter lives in, spelled as `GET /admin/carts` spells it. */
const STATE = "state";

/** Where this section lives, exactly as `app.tsx` and `lib/sections.ts` spell it. */
const HERE = "/carts";

export function Carts() {
  const client = useKobaiClient();
  const after = usePageCursor();
  const { asked, value: state, unknownValue } = useListFilter(STATE, OFFERED);

  const page = useQuery({
    // The filter is part of the key beside the cursor: a page of live Carts and a page of spent
    // ones are two different answers to two different questions.
    //
    // Keyed on what the **address** asked for rather than on the state it narrowed to, so that
    // a word kobai does not have is its own key rather than the unfiltered list's. The two are
    // the same key for every address that names a real state; they differ for exactly the one
    // that does not, which is the one whose answer must not be a page somebody else fetched.
    queryKey: [CARTS, asked, after ?? null],
    queryFn: async () =>
      orThrow(
        await client.GET("/admin/carts", {
          params: {
            query: {
              // Each omitted rather than sent empty. An empty `after` is a cursor kobai never
              // issued and is refused as one, and an empty `state` is not one of the three.
              ...(after === undefined ? {} : { after }),
              ...(state === undefined ? {} : { state }),
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
    // Nothing is asked for while the address names a state kobai has never heard of: the screen
    // has an answer already, and it is not one kobai could improve on.
    enabled: unknownValue === null,
  });

  // Nothing at all while the address names no state kobai has, and that is the assertion rather
  // than a tidiness: `placeholderData` hands this observer the page it was last showing while a
  // new key is in flight, so a screen that read `page.data` here would print "no such Cart
  // state" over the rows of whichever filter the Merchant came from — the quiet failure this
  // screen exists to prevent, wearing the honest answer's clothes.
  const carts = unknownValue === null ? page.data?.carts : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Carts
          {/* A refetch, which is a different thing from a first load — and the first load has
              a skeleton of its own below. */}
          {page.isFetching && !page.isPending ? <Spinner /> : null}
        </CardTitle>
        <CardDescription>
          What Shoppers are holding, newest first. A live Cart may still be placed and may
          be holding stock; an expired one ran out of time, and a spent one has already
          become an Order.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ListFilter
          label="Filter the Carts"
          section={HERE}
          parameter={STATE}
          asked={asked}
          options={OPTIONS}
        />

        <Problem
          problem={
            page.isError ? problemOf(page.error, "The Carts could not be read.") : null
          }
        />

        {unknownValue === null ? null : <NoSuchState asked={unknownValue} />}

        {page.isPending && unknownValue === null ? <CartsLoading /> : null}

        {carts !== undefined && carts.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShoppingCartIcon />
              </EmptyMedia>
              <EmptyTitle>No Carts to show</EmptyTitle>
              <EmptyDescription>
                A Cart appears when a storefront starts one over <code>/store</code>.
                Nothing in this Admin can create one, and nothing here can change one.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {carts !== undefined && carts.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cart</TableHead>
                <TableHead>Shopper</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Deadline</TableHead>
                {/* Named rather than empty: a column header with no text is a column a
                    screen reader announces as nothing at all. */}
                <TableHead className="w-0">
                  <span className="sr-only">Open</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {carts.map((cart) => (
                <TableRow key={cart.id}>
                  {/* The identifier, whole and unabbreviated: it is what addresses this Cart
                      and what a Merchant would quote, and half of one is neither. */}
                  <TableCell className="font-medium">
                    <code className="break-all">{cart.id}</code>
                  </TableCell>
                  <TableCell>{cart.shopper?.email ?? "guest"}</TableCell>
                  <TableCell>
                    <CartStateBadge cart={cart} />
                  </TableCell>
                  <TableCell>{new Date(cart.createdAt).toLocaleString()}</TableCell>
                  <TableCell>{new Date(cart.expiresAt).toLocaleString()}</TableCell>
                  <TableCell>
                    <LinkButton to={`/carts/${cart.id}`} size="sm" variant="outline">
                      Open
                    </LinkButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}

        <Pager nextCursor={page.data?.nextCursor} label="Carts" />
      </CardContent>
    </Card>
  );
}

/**
 * An address naming a state kobai does not have.
 *
 * Only ever reached by typing or by following a stale link, and it says so rather than quietly
 * showing every Cart — a filter that was dropped answers a different question from the one that
 * was asked, and a Merchant reading the whole table would not know it had been. kobai refuses
 * this word too, with `invalid`; this screen is what stops the round trip being needed to find
 * out.
 */
function NoSuchState({ asked }: { readonly asked: string }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShoppingCartIcon />
        </EmptyMedia>
        <EmptyTitle>No such Cart state</EmptyTitle>
        <EmptyDescription>
          kobai knows no Cart state called “{asked}”. A Cart is live, expired or spent,
          and the three above are the whole of it.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * A page of Carts, before there is one.
 *
 * The same skeleton the other lists show, for the same reason: a shape says how much is coming,
 * and "Reading the Carts…" only says to wait.
 */
function CartsLoading() {
  return (
    <div className="grid gap-3" role="status" aria-label="Reading the Carts">
      {["first", "second", "third"].map((row) => (
        <Skeleton key={row} className="h-9 w-full" />
      ))}
    </div>
  );
}
