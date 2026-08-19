import type { Variant } from "@kobai/client";
import { useQuery } from "@tanstack/react-query";
import { PackageXIcon } from "lucide-react";
import { LinkButton } from "@/components/link-button";
import { Problem } from "@/components/problem";
import { StorefrontPrice } from "@/components/storefront-price";
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
import { Separator } from "@/components/ui/separator";
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
import { catalogReasonOf, orThrow, problemOf } from "@/lib/refusal";
import { useRouteId } from "@/lib/route";
import { useKobaiClient } from "@/lib/session";

/**
 * One Product, with its Variants and each Variant's Prices (spec story 23).
 *
 * Prices are a list rather than a field, because a Price is a row (ADR-0008): setting one
 * twice leaves two, and that is how a sale price or a second currency arrives later without
 * a migration. The Admin shows them all rather than pretending there is one.
 *
 * The Product is read through TanStack Query, keyed by the identifier in the URL, so opening
 * one and coming back is the cache answering rather than a second round trip — and a refresh
 * on this address lands here, because the address is the whole of what this screen needs
 * (ADR-0063).
 */
const PRODUCT = "product";

export function ProductScreen() {
  const client = useKobaiClient();
  const id = useRouteId();

  const product = useQuery({
    queryKey: [PRODUCT, id],
    queryFn: async () =>
      orThrow(await client.GET("/admin/products/{id}", { params: { path: { id } } })),
  });

  // The breadcrumb otherwise reads as the identifier out of the URL, which is the one thing
  // on this screen a Merchant cannot use to tell one Product from another.
  useCrumbTitle(product.data?.title);

  if (product.isPending) return <ProductLoading />;

  if (product.isError) {
    return isNoSuchProduct(product.error) ? (
      <NoSuchProduct />
    ) : (
      <Problem
        title="That Product could not be read."
        problem={problemOf(product.error, "kobai did not answer.")}
      />
    );
  }

  return (
    <div className="grid gap-6">
      {/* An `h2`: the frame renders the page's `h1` from the route, so this is the heading
          under it rather than a second first-level one. */}
      <h2 className="font-medium text-xl">{product.data.title}</h2>

      {product.data.variants.map((variant) => {
        // Newest first is what the API answers with, so the head of the list is the Price a
        // Merchant most recently entered — the one worth comparing against.
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
                variantId={variant.id}
                entered={
                  newest ? { amount: newest.amount, currency: newest.currency } : null
                }
              />
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * The Product, before it is there.
 *
 * A skeleton in the shape of the card it stands in for, rather than "Reading the Product…" —
 * both say wait, and only one says how much is coming. `role="status"` is what makes it
 * announced rather than a silent shuffle of grey boxes.
 */
function ProductLoading() {
  return (
    <div className="grid gap-6" role="status" aria-label="Reading the Product">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/**
 * An address naming a Product this Store does not have.
 *
 * Its own screen rather than a red box, because it is the one refusal here a Merchant can act
 * on and the action is "go to the list" — a deleted Product, or a link somebody kept. The
 * reason is narrowed rather than read out of the prose, so a `CatalogRefusal` gaining another
 * 404 reddens this build rather than showing this screen for it (ADR-0063).
 */
function NoSuchProduct() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PackageXIcon />
        </EmptyMedia>
        <EmptyTitle>No such Product</EmptyTitle>
        <EmptyDescription>
          This Store has no Product at that address. It may have been deleted since the
          link was made.
        </EmptyDescription>
      </EmptyHeader>
      <LinkButton to="/products">Go to Products</LinkButton>
    </Empty>
  );
}

/**
 * Why kobai would not hand this Product over.
 *
 * `product-not-found` is the only one this screen has a screen for; the rest are reported as
 * kobai said them, because they are refusals from a route that takes no body and names no SKU
 * and so cannot be reworded better here. The `never` is what keeps the list complete: a reason
 * added to `CatalogRefusal` has no arm and does not compile.
 */
function isNoSuchProduct(thrown: unknown): boolean {
  const reason = catalogReasonOf(thrown);

  switch (reason) {
    case "product-not-found":
      return true;

    case "invalid":
    case "malformed-body":
    case "variant-not-found":
    case "price-not-found":
    case "sku-taken":
    case "last-variant":
    case "stock-is-reserved":
    case "unsupported-currency":
    case "unknown-fulfilment-strategy":
      // Not reachable from a read of one Product as it stands, so kobai's own prose is shown
      // rather than a sentence written here for a case nobody has seen.
      return false;

    case undefined:
      // A 500, which carries no `reason` on purpose, or the network being gone.
      return false;

    default: {
      const unreached: never = reason;
      return unreached;
    }
  }
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
 * form for it is #179's, with the other operations the Admin cannot yet reach.
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
