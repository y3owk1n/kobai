import type { KobaiClient, Order } from "@kobai/client";
import { Fragment, useCallback, useEffect, useState } from "react";
import { PaymentBadge } from "@/components/payment-badge";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatAmount } from "@/lib/money";
import { messageOf } from "@/lib/refusal";

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
 */
export function OrderScreen({
  client,
  id,
  onBack,
}: {
  readonly client: KobaiClient;
  readonly id: string;
  readonly onBack: () => void;
}) {
  const [order, setOrder] = useState<Order | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await client.GET("/admin/orders/{id}", {
      params: { path: { id } },
    });
    if (data) {
      setOrder(data);
      setProblem(null);
      return;
    }
    setProblem(messageOf(error, "That Order could not be read."));
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="grid gap-6">
      <div>
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← All Orders
        </Button>
      </div>

      <Problem problem={problem} />

      {order === null && problem === null ? (
        <p className="text-muted-foreground text-sm">Reading the Order…</p>
      ) : null}

      {order ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="font-medium text-xl">Order #{order.number}</h1>
            <PaymentBadge payment={order.payment} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>What was bought</CardTitle>
              <CardDescription>
                As it was described and priced at Capture. The catalog has been free to
                change ever since, and none of it reaches these lines.
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
                  {order.lineItems.map((line) => (
                    <TableRow key={line.id}>
                      <TableCell className="font-medium">
                        {line.title}
                        {line.adjustments.map((adjustment) => (
                          <div
                            className="text-muted-foreground text-xs"
                            key={adjustment.id}
                          >
                            {adjustment.description}{" "}
                            {formatAmount(adjustment.amount, order.currency)}
                          </div>
                        ))}
                      </TableCell>
                      <TableCell>
                        <code>{line.sku}</code>
                      </TableCell>
                      <TableCell>
                        {formatAmount(line.unitAmount, order.currency)}
                      </TableCell>
                      <TableCell>{line.quantity}</TableCell>
                      <TableCell>{formatAmount(line.tax, order.currency)}</TableCell>
                      <TableCell>{formatAmount(line.total, order.currency)}</TableCell>
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
                An Adjustment belonging to no single line — a basket-wide voucher, say —
                is listed here rather than folded into the figure.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {order.adjustments.map((adjustment) => (
                <Fragment key={adjustment.id}>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      {adjustment.description}
                    </span>
                    <span>{formatAmount(adjustment.amount, order.currency)}</span>
                  </div>
                  {/*
                   * An Order-level Adjustment carries its own tax, because there is no line
                   * whose tax could carry it — a delivery surcharge is taxable and belongs to
                   * no line. Shown only when there is some: this deployment's tax Step decides,
                   * and Core charges none, so a row of zeroes would be noise on every Order.
                   */}
                  {adjustment.tax !== 0 && (
                    <div className="flex justify-between pl-4">
                      {/* Just "Tax": the description beside it is the Merchant's own text,
                          and composing a sentence out of it would mangle a proper noun. */}
                      <span className="text-muted-foreground">Tax</span>
                      <span>{formatAmount(adjustment.tax, order.currency)}</span>
                    </div>
                  )}
                </Fragment>
              ))}
              <div className="flex justify-between font-medium">
                <span>Total</span>
                <span>{formatAmount(order.total, order.currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Shopper</span>
                <span>{order.shopper?.email ?? "guest"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Placed</span>
                <span>{new Date(order.createdAt).toLocaleString()}</span>
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
              {order.payment === null ? (
                <p className="text-muted-foreground">
                  No Payment is recorded against this Order, so kobai holds no account of
                  the money for it at all.
                </p>
              ) : (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Provider</span>
                    <span>{order.payment.provider}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Reference</span>
                    <code className="break-all">{order.payment.reference}</code>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Amount</span>
                    <span>
                      {formatAmount(order.payment.amount, order.payment.currency)}
                    </span>
                  </div>
                  {order.payment.received ? null : (
                    // The whole point of the distinction, said in words as well as in a badge:
                    // this provider arranged the money and did not take it.
                    <p className="text-muted-foreground">
                      This payment was arranged rather than taken — the money has not
                      arrived, and collecting it happens outside kobai.
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
