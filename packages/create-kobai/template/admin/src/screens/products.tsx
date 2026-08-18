import type { KobaiClient, Product } from "@kobai/client";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { messageOf } from "@/lib/refusal";

/**
 * The Products this Merchant has created (spec story 22).
 *
 * `GET /admin/products` answers newest first, a page at a time (ADR-0064), and this screen asks
 * for no page and shows what arrives — **so it shows the first page and no more**. See the
 * Orders screen for why that gap is left open here rather than closed.
 *
 * The form beneath it creates one. No acceptance criterion asks for creation, and it is here
 * because the criteria that *are* asked for cannot otherwise be seen: a Merchant on a fresh
 * deployment would have to reach for `curl` before the Admin could list anything, price
 * anything, or show a resolved price differing from an entered one. It is two ordinary calls
 * — `POST /admin/products` then `POST /admin/variants/{id}/prices` — and nothing else.
 */
export function Products({
  client,
  onOpen,
}: {
  readonly client: KobaiClient;
  readonly onOpen: (id: string) => void;
}) {
  const [products, setProducts] = useState<readonly Product[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await client.GET("/admin/products");
    if (data) {
      setProducts(data.products);
      setProblem(null);
      return;
    }
    setProblem(messageOf(error, "The Products could not be read."));
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Products</CardTitle>
          <CardDescription>
            Everything this Store sells. Open one to see its Variant, its Price, and the
            price a storefront would receive.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Problem problem={problem} />
          {products === null && problem === null ? (
            <p className="text-muted-foreground text-sm">Reading the catalog…</p>
          ) : null}
          {products !== null && products.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No Products yet. Create one below.
            </p>
          ) : null}
          {products !== null && products.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((product) => (
                  <TableRow key={product.id}>
                    <TableCell className="font-medium">{product.title}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onOpen(product.id)}
                      >
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

      <NewProduct client={client} onCreated={() => void load()} />
    </div>
  );
}

function NewProduct({
  client,
  onCreated,
}: {
  readonly client: KobaiClient;
  readonly onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [sku, setSku] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setProblem(null);

    // A Product and its Variants are created together: a Product with no Variant is not a
    // state the API can produce, because a Product is never sellable in itself (ADR-0008).
    const created = await client.POST("/admin/products", {
      body: { title, variants: [{ sku }] },
    });
    const variant = created.data?.variants[0];

    if (!created.data || !variant) {
      setProblem(messageOf(created.error, "The Product could not be created."));
      setBusy(false);
      return;
    }

    // A Price is a row on the Variant, added second and separately — which is what makes a
    // sale price or a second currency more rows later rather than a migration (ADR-0008).
    const priced = await client.POST("/admin/variants/{id}/prices", {
      params: { path: { id: variant.id } },
      body: { amount: Number(amount) },
    });
    if (!priced.data) {
      setProblem(messageOf(priced.error, "The Product was created but not priced."));
    } else {
      setTitle("");
      setSku("");
      setAmount("");
    }

    setBusy(false);
    onCreated();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New Product</CardTitle>
        <CardDescription>
          One Product, one Variant, one Price — the thinnest sellable thing.
        </CardDescription>
      </CardHeader>
      <form onSubmit={submit}>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <Problem problem={problem} className="sm:col-span-3" />
          <div className="grid gap-1.5">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sku">SKU</Label>
            <Input
              id="sku"
              value={sku}
              onChange={(event) => setSku(event.target.value)}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="amount">Price, in minor units</Label>
            <Input
              id="amount"
              inputMode="numeric"
              placeholder="1250"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
          </div>
        </CardContent>
        <CardFooter className="mt-4">
          <Button type="submit" disabled={busy}>
            Create
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
