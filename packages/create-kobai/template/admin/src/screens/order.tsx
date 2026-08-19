import { useQuery } from "@tanstack/react-query";
import { ReceiptTextIcon } from "lucide-react";
import { Fragment } from "react";
import { LinkButton } from "@/components/link-button";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCrumbTitle } from "@/lib/crumb";
import { formatAmount } from "@/lib/money";
import { orderReasonOf, orThrow, problemOf } from "@/lib/refusal";
import { useRouteId } from "@/lib/route";
import { useKobaiClient } from "@/lib/session";

/**
 * One Order, opened — its Line Items, its Adjustments, its totals and its Payment (story 57).
 *
 * Every field here is a **snapshot**: the title and the SKU are what they were at Capture, not
 * what the catalog says now, because renaming a Product must not rewrite history and deleting a
 * Variant must not destroy this record (ADR-0009). So nothing on this screen links back into
 * the catalog — what it shows is the Order, whole.
 *
 * An Adjustment is a line rather than a number folded into an amount (ADR-0022), so it is shown
 * as one: the unit amount still says what one of the thing cost, and the line's total is what it
 * came to with the discounts and surcharges accounted for.
 *
 * **An Order never changes, and the query is still an ordinary one** — no `staleTime` of its
 * own. Immutability is Core's promise about the record, not a licence for the Admin to hold a
 * copy of it forever: a Merchant who reloads is asking kobai, and a cache that answered from
 * ADR-0009 would be the Admin re-implementing a rule it does not own (ADR-0063).
 */
const ORDER = "order";

export function OrderScreen() {
  const client = useKobaiClient();
  const id = useRouteId();

  const order = useQuery({
    queryKey: [ORDER, id],
    queryFn: async () =>
      orThrow(await client.GET("/admin/orders/{id}", { params: { path: { id } } })),
  });

  // "#1043" rather than the identifier out of the URL, because the number is what a Shopper
  // quotes and the identifier is what nobody reads aloud.
  useCrumbTitle(order.data === undefined ? undefined : `#${order.data.number}`);

  if (order.isPending) return <OrderLoading />;

  if (order.isError) {
    return isNoSuchOrder(order.error) ? (
      <NoSuchOrder />
    ) : (
      <Problem
        title="That Order could not be read."
        problem={problemOf(order.error, "kobai did not answer.")}
      />
    );
  }

  const placed = order.data;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* An `h2`: the frame renders the page's `h1` from the route, so this is the record's
            own heading under the section's rather than a second first-level one. */}
        <h2 className="font-medium text-xl">Order #{placed.number}</h2>
        <PaymentBadge payment={placed.payment} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What was bought</CardTitle>
          <CardDescription>
            As it was described and priced at Capture. The catalog has been free to change
            ever since, and none of it reaches these lines.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Line Item</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Tax</TableHead>
                <TableHead>Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {placed.lineItems.map((line) => (
                <TableRow key={line.id}>
                  <TableCell className="font-medium">
                    {line.title}
                    {line.adjustments.map((adjustment) => (
                      <div className="text-muted-foreground text-xs" key={adjustment.id}>
                        {adjustment.description}{" "}
                        {formatAmount(adjustment.amount, placed.currency)}
                      </div>
                    ))}
                  </TableCell>
                  <TableCell>
                    <code>{line.sku}</code>
                  </TableCell>
                  <TableCell>{formatAmount(line.unitAmount, placed.currency)}</TableCell>
                  <TableCell>{line.quantity}</TableCell>
                  <TableCell>{formatAmount(line.tax, placed.currency)}</TableCell>
                  <TableCell>{formatAmount(line.total, placed.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What it came to</CardTitle>
          <CardDescription>
            An Adjustment belonging to no single line — a basket-wide voucher, say — is
            listed here rather than folded into the figure.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {placed.adjustments.map((adjustment) => (
            <Fragment key={adjustment.id}>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{adjustment.description}</span>
                <span>{formatAmount(adjustment.amount, placed.currency)}</span>
              </div>
              {/*
               * An Order-level Adjustment carries its own tax, because there is no line whose
               * tax could carry it — a delivery surcharge is taxable and belongs to no line.
               * Shown only when there is some: this deployment's tax Step decides, and Core
               * charges none, so a row of zeroes would be noise on every Order.
               */}
              {adjustment.tax !== 0 && (
                <div className="flex justify-between pl-4">
                  {/* Just "Tax": the description beside it is the Merchant's own text, and
                      composing a sentence out of it would mangle a proper noun. */}
                  <span className="text-muted-foreground">Tax</span>
                  <span>{formatAmount(adjustment.tax, placed.currency)}</span>
                </div>
              )}
            </Fragment>
          ))}
          <div className="flex justify-between font-medium">
            <span>Total</span>
            <span>{formatAmount(placed.total, placed.currency)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Shopper</span>
            <span>{placed.shopper?.email ?? "guest"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Placed</span>
            <span>{new Date(placed.createdAt).toLocaleString()}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payment</CardTitle>
          <CardDescription>
            What kobai was told about the money. The reference is the provider's own
            handle on it — quote it there, not here.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {placed.payment === null ? (
            <p className="text-muted-foreground">
              No Payment is recorded against this Order, so kobai holds no account of the
              money for it at all.
            </p>
          ) : (
            <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Provider</span>
                <span>{placed.payment.provider}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Reference</span>
                <code className="break-all">{placed.payment.reference}</code>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount</span>
                <span>
                  {formatAmount(placed.payment.amount, placed.payment.currency)}
                </span>
              </div>
              {placed.payment.received ? null : (
                // The whole point of the distinction, said in words as well as in a badge:
                // this provider arranged the money and did not take it.
                <p className="text-muted-foreground">
                  This payment was arranged rather than taken — the money has not arrived,
                  and collecting it happens outside kobai.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The Order, before it is there.
 *
 * Three blocks, because three cards are coming. Announced as a status so that a Merchant
 * whose screen is being read to them is told the page is working rather than left in silence.
 */
function OrderLoading() {
  return (
    <div className="grid gap-6" role="status" aria-label="Reading the Order">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/**
 * An address naming an Order this Store never took.
 *
 * Its own screen rather than a red box, because the action is "go back to the list" and a
 * Merchant following somebody's link has nothing else to do. An Order is never deleted
 * (ADR-0009), so this is a mistyped or stale address rather than something that used to work.
 */
function NoSuchOrder() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ReceiptTextIcon />
        </EmptyMedia>
        <EmptyTitle>No such Order</EmptyTitle>
        <EmptyDescription>
          This Store has taken no Order at that address. An Order is never deleted, so
          this address has always been wrong rather than having stopped working.
        </EmptyDescription>
      </EmptyHeader>
      <LinkButton to="/orders">Go to Orders</LinkButton>
    </Empty>
  );
}

/**
 * Whether kobai said there is no such Order, as against anything else going wrong.
 *
 * Narrowed rather than read out of the prose, and exhaustive over `OrderRefusal` — a second
 * reason added to that family in Core has no arm here and reddens this build in the same
 * commit, rather than quietly showing "No such Order" for something else (ADR-0063).
 */
function isNoSuchOrder(thrown: unknown): boolean {
  const reason = orderReasonOf(thrown);

  switch (reason) {
    case "order-not-found":
      return true;

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
