import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ReceiptTextIcon } from "lucide-react";
import { LinkButton } from "@/components/link-button";
import { Pager, usePageCursor } from "@/components/pager";
import { PaymentBadge } from "@/components/payment-badge";
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
import { formatAmount } from "@/lib/money";
import { orThrow, problemOf } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/**
 * What this Store has sold (spec story 56), a page at a time.
 *
 * **This is the list guaranteed to grow without bound**, which is why it pages exactly as
 * Products does: `GET /admin/orders` answers newest first with an opaque `nextCursor`
 * (ADR-0064), and **the cursor this page was asked for is in the URL** — so a page is a link,
 * a refresh lands on it, and the back button walks back through the pages.
 * `components/pager.tsx` owns that; this screen owns what a page of Orders looks like.
 *
 * There are no page numbers to render and there is no total, and neither is an omission: a
 * cursor says what comes *next* and can say nothing about what came before it, so the control
 * a deep link into page three offers is "First page" rather than a "Previous" that would mean
 * something else.
 *
 * There is no form under this one, unlike the Products screen. An Order is placed by a
 * storefront over `/store` and is immutable once it exists (ADR-0009), so there is nothing here
 * for a Merchant to create and nothing to edit. A Merchant who lacks `order:read` is refused by
 * the API and reads why, rather than being shown a screen that quietly hides itself.
 */
const ORDERS = "orders";

export function Orders() {
  const client = useKobaiClient();
  const after = usePageCursor();

  const page = useQuery({
    // The cursor is part of the key, so each page is cached as itself.
    queryKey: [ORDERS, after ?? null],
    queryFn: async () =>
      orThrow(
        await client.GET("/admin/orders", {
          // `after` is omitted rather than sent empty for the first page: an empty string is
          // not a cursor kobai issued, and it is refused as one.
          params: { query: after === undefined ? {} : { after } },
        }),
      ),
    // The previous page stays on screen while the next one is fetched, so moving through a
    // list is a spinner over what you were reading rather than the whole table disappearing.
    placeholderData: keepPreviousData,
  });

  const orders = page.data?.orders;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Orders
          {/* A refetch, which is a different thing from a first load — and the first load has
              a skeleton of its own below. */}
          {page.isFetching && !page.isPending ? <Spinner /> : null}
        </CardTitle>
        <CardDescription>
          Every Order this Store has taken, newest first. Open one to see what was bought
          and what it came to.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Problem
          problem={
            page.isError ? problemOf(page.error, "The Orders could not be read.") : null
          }
        />

        {page.isPending ? <OrdersLoading /> : null}

        {orders !== undefined && orders.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ReceiptTextIcon />
              </EmptyMedia>
              <EmptyTitle>Nothing has been sold yet</EmptyTitle>
              <EmptyDescription>
                An Order arrives when a storefront places a Cart over <code>/store</code>.
                Nothing in this Admin can create one, because an Order is a Shopper's.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {orders !== undefined && orders.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Placed</TableHead>
                <TableHead>Shopper</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Payment</TableHead>
                {/* Named rather than empty: a column header with no text is a column a
                    screen reader announces as nothing at all. */}
                <TableHead className="w-0">
                  <span className="sr-only">Open</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.id}>
                  {/* The number, not the identifier — this is what a Shopper quotes. */}
                  <TableCell className="font-medium">#{order.number}</TableCell>
                  <TableCell>{new Date(order.createdAt).toLocaleString()}</TableCell>
                  <TableCell>{order.shopper?.email ?? "guest"}</TableCell>
                  <TableCell>{formatAmount(order.total, order.currency)}</TableCell>
                  <TableCell>
                    <PaymentBadge payment={order.payment} />
                  </TableCell>
                  <TableCell>
                    <LinkButton to={`/orders/${order.id}`} size="sm" variant="outline">
                      Open
                    </LinkButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}

        <Pager nextCursor={page.data?.nextCursor} label="Orders" />
      </CardContent>
    </Card>
  );
}

/**
 * A page of Orders, before there is one.
 *
 * The same skeleton the Products list shows, for the same reason: a shape says how much is
 * coming, and "Reading the Orders…" only says to wait.
 */
function OrdersLoading() {
  return (
    <div className="grid gap-3" role="status" aria-label="Reading the Orders">
      {["first", "second", "third"].map((row) => (
        <Skeleton key={row} className="h-9 w-full" />
      ))}
    </div>
  );
}
