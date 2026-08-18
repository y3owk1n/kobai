import type { KobaiClient, ProductDetail, Variant } from "@kobai/client";
import { useCallback, useEffect, useState } from "react";
import { Problem } from "@/components/problem";
import { StorefrontPrice } from "@/components/storefront-price";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
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
 * One Product, with its Variants and each Variant's Prices (spec story 23).
 *
 * Prices are a list rather than a field, because a Price is a row (ADR-0008): setting one
 * twice leaves two, and that is how a sale price or a second currency arrives later without
 * a migration. The Admin shows them all rather than pretending there is one.
 */
export function ProductScreen({
  client,
  id,
  onBack,
}: {
  readonly client: KobaiClient;
  readonly id: string;
  readonly onBack: () => void;
}) {
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await client.GET("/admin/products/{id}", {
      params: { path: { id } },
    });
    if (data) {
      setProduct(data);
      setProblem(null);
      return;
    }
    setProblem(messageOf(error, "That Product could not be read."));
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="grid gap-6">
      <div>
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← All Products
        </Button>
      </div>

      <Problem problem={problem} />

      {product === null && problem === null ? (
        <p className="text-muted-foreground text-sm">Reading the Product…</p>
      ) : null}

      {product ? <h1 className="font-medium text-xl">{product.title}</h1> : null}

      {product
        ? product.variants.map((variant) => {
            // Newest first is what the API answers with, so the head of the list is the
            // Price a Merchant most recently entered — the one worth comparing against.
            const newest = variant.prices[0] ?? null;
            return (
              <Card key={variant.id}>
                <CardHeader>
                  <CardTitle>
                    Variant <code>{variant.sku}</code>
                  </CardTitle>
                  <CardDescription>
                    Every Product has at least one Variant, and the Variant is what is
                    sellable and what carries Prices (ADR-0008).
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4">
                  {variant.prices.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      This Variant carries no Price, so it is not sellable yet.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Price</TableHead>
                          <TableHead>Currency</TableHead>
                          <TableHead>Minor units</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {variant.prices.map((price) => (
                          <TableRow key={price.id}>
                            <TableCell className="font-medium">
                              {formatAmount(price.amount, price.currency)}
                            </TableCell>
                            <TableCell>{price.currency}</TableCell>
                            <TableCell>{price.amount}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}

                  <Separator />

                  <Stock inventory={variant.inventory} />

                  <Separator />

                  <StorefrontPrice
                    client={client}
                    variantId={variant.id}
                    entered={
                      newest ? { amount: newest.amount, currency: newest.currency } : null
                    }
                  />
                </CardContent>
              </Card>
            );
          })
        : null}
    </div>
  );
}

/**
 * What the Store has of a Variant, and what is left to sell (ADR-0018).
 *
 * **Untracked is `null` and says so in words**, because it is not the same as none left: a
 * Variant nobody counts sells freely, and a Merchant looking at a blank number would have no way
 * to tell which of the two they were looking at.
 *
 * `reserved` is shown beside `available` rather than folded into it. It is the stock claimed by
 * Orders currently being placed, so a Merchant who sees fewer available than they counted has the
 * explanation in the same row instead of a discrepancy to chase.
 *
 * Read-only here. Counting stock is `PUT /admin/variants/{id}/inventory` and the API has it; a
 * form for it is a screen this Admin has not grown yet.
 */
function Stock({ inventory }: { readonly inventory: Variant["inventory"] }) {
  if (inventory === null) {
    return (
      <p className="text-muted-foreground text-sm">
        Nobody is counting this Variant, so it sells freely — which is not the same as
        having none left.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>On hand</TableHead>
          <TableHead>Reserved</TableHead>
          <TableHead>Available</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell className="font-medium">{inventory.onHand}</TableCell>
          <TableCell>{inventory.reserved}</TableCell>
          <TableCell>{inventory.available}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}
