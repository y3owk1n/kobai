import type { KobaiClient, OrderSummary } from "@kobai/client";
import { useCallback, useEffect, useState } from "react";
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
 * What this Store has sold (spec story 56).
 *
 * `GET /admin/orders` answers newest first, a page at a time (ADR-0064), and this screen asks
 * for no page and shows what arrives — **so it shows the first page and no more**, with no way
 * to reach the second. That is a known gap rather than a bargain: following `nextCursor` wants
 * somewhere to keep it, and this Admin has no router to keep it in. The frame that has one is
 * what closes it, and the Products and API key lists are in the same position.
 *
 * There is no form under this one, unlike the Products screen. An Order is placed by a
 * storefront over `/store` and is immutable once it exists (ADR-0009), so there is nothing here
 * for a Merchant to create and nothing to edit. A Merchant who lacks `order:read` is refused by
 * the API and reads why, rather than being shown a screen that quietly hides itself.
 */
export function Orders({
  client,
  onOpen,
}: {
  readonly client: KobaiClient;
  readonly onOpen: (id: string) => void;
}) {
  const [orders, setOrders] = useState<readonly OrderSummary[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await client.GET("/admin/orders");
    if (data) {
      setOrders(data.orders);
      setProblem(null);
      return;
    }
    setProblem(messageOf(error, "The Orders could not be read."));
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Orders</CardTitle>
        <CardDescription>
          Every Order this Store has taken, newest first. Open one to see what was bought
          and what it came to.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Problem problem={problem} />
        {orders === null && problem === null ? (
          <p className="text-muted-foreground text-sm">Reading the Orders…</p>
        ) : null}
        {orders !== null && orders.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing has been sold yet. An Order arrives when a storefront places a Cart.
          </p>
        ) : null}
        {orders !== null && orders.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Placed</TableHead>
                <TableHead>Shopper</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead className="w-0" />
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
                    <Button size="sm" variant="outline" onClick={() => onOpen(order.id)}>
                      Open
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}
