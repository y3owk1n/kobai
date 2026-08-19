import { zodResolver } from "@hookform/resolvers/zod";
import type { Price, Variant } from "@kobai/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageXIcon } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { z } from "zod";
import { ActionButton } from "@/components/action-button";
import { ConfirmDelete } from "@/components/confirm-delete";
import { FormField } from "@/components/form-field";
import { FulfilmentStrategyField } from "@/components/fulfilment-strategy-field";
import { LinkButton } from "@/components/link-button";
import { Problem } from "@/components/problem";
import { StorefrontPrice } from "@/components/storefront-price";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
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
import { Spinner } from "@/components/ui/spinner";
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
import { PERMISSIONS, useUnavailable } from "@/lib/permissions";
import { catalogReasonOf, orThrow, problemOf } from "@/lib/refusal";
import { useRouteId } from "@/lib/route";
import { useKobaiClient } from "@/lib/session";

/**
 * One Product, and every operation kobai's admin surface offers on a catalog entry (#179).
 *
 * Prices are a list rather than a field, because a Price is a row (ADR-0008): setting one
 * twice leaves two, and that is how a sale price or a second currency arrives later without
 * a migration. The Admin shows them all rather than pretending there is one.
 *
 * The Product is read through TanStack Query, keyed by the identifier in the URL, so opening
 * one and coming back is the cache answering rather than a second round trip — and a refresh
 * on this address lands here, because the address is the whole of what this screen needs
 * (ADR-0063).
 *
 * **Everything writes through this one query key and nothing is patched in place.** Renaming,
 * counting stock, correcting a SKU, adding or removing a Variant or a Price: each invalidates
 * `[PRODUCT, id]` and re-reads. That is ADR-0063's no-optimistic-updates rule, and here it
 * earns its keep twice over — what a Variant's `available` becomes after a count is
 * `onHand - reserved`, a subtraction against a number this browser does not have, and what a
 * Product looks like once a Variant is gone is kobai's answer rather than a filtered array.
 *
 * **Nothing predicts a refusal.** No control asks whether a delete would be allowed before
 * offering it: `last-variant` and `stock-is-reserved` are rules that live in Core, that Core
 * may change, and that a Developer's Project may already have changed. Every delete here is
 * attempted and its answer rendered in the dialog it was attempted from (ADR-0059).
 *
 * **Every card title here is an `h3`, which the other screens' are not.** The frame's `h1`
 * names the section and this screen's `h2` names the Product, so the cards under it are the
 * next level — and this is the one screen long enough for that to matter: a Product with four
 * Variants is four repetitions of the same four sections, and without headings it is one
 * undifferentiated page to anybody navigating by them. `CardTitle` is a `div` in this
 * distribution and is left alone, so the heading is an element inside it rather than an edit to
 * a vendored component (ADR-0063). A screen whose cards are a list of records rather than
 * sections of one — Products, Orders, API keys — is right to have none.
 */
const PRODUCT = "product";

/**
 * Why this Merchant cannot change the catalog, or `null` when they can.
 *
 * Six controls on this screen ask it and every one of them wants the same sentence, so it is
 * asked in one place: a wording that differed between the rename button and the delete button
 * would read as two different rules. It is an affordance and not a boundary —
 * `requirePermission` in Core is the enforcement, and `lib/permissions.ts` is where that is
 * written down at length.
 */
function useCannotWrite(): string | null {
  return useUnavailable(PERMISSIONS.catalogWrite, "change the catalog");
}

/**
 * Re-reads the Product, which is what every write on this screen does instead of patching.
 *
 * There is no optimistic update anywhere in this Admin (ADR-0063), so each of the six
 * mutations below ends the same way — and ending it the same way is the point: what a Variant's
 * `available` becomes after a count is `onHand - reserved`, a subtraction against a number this
 * browser does not have.
 */
function useRereadProduct(productId: string): () => void {
  const queries = useQueryClient();
  return () => void queries.invalidateQueries({ queryKey: [PRODUCT, productId] });
}

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

      <ProductIdentity id={id} title={product.data.title} />

      {product.data.variants.map((variant) => (
        <VariantCard key={variant.id} productId={id} variant={variant} />
      ))}

      <NewVariant productId={id} />
    </div>
  );
}

/**
 * The Product itself: what it is called, and the way to take it out of the catalog.
 *
 * A `PATCH` naming only the title, because `metadata` is *replaced* rather than merged and a
 * form that sent an empty object would silently discard whatever a Project stashed there
 * (ADR-0062). Editing metadata is a screen nobody has asked for; sending it blank is data loss.
 */
function ProductIdentity({ id, title }: { readonly id: string; readonly title: string }) {
  const client = useKobaiClient();
  // Both, because deleting a Product invalidates more than the Product: the list behind it is
  // stale too, and that is the whole `[PRODUCT]` family rather than this one's key.
  const queries = useQueryClient();
  const reread = useRereadProduct(id);
  const navigate = useNavigate();
  const unavailable = useCannotWrite();

  const form = useForm({
    resolver: zodResolver(RenameForm),
    // Keyed by the value it was opened with, so a rename that landed leaves the field showing
    // what kobai now holds rather than what was typed.
    values: { title },
  });

  const rename = useMutation({
    mutationFn: async (values: { title: string }) =>
      orThrow(
        await client.PATCH("/admin/products/{id}", {
          params: { path: { id } },
          body: { title: values.title },
        }),
      ),
    onSuccess: reread,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Product</h3>
        </CardTitle>
        <CardDescription>
          A title is what a Product is called and not what identifies it, so two may share
          one and correcting a typo rewrites nothing already sold (ADR-0009).
        </CardDescription>
        <CardAction>
          <ConfirmDelete
            trigger="Delete Product"
            title="Delete this Product?"
            description="Its Variants and their Prices go with it. Orders already placed are untouched — an Order's Line Items are a snapshot (ADR-0009) — so this removes it from the catalog and from nothing else."
            unavailable={unavailable}
            onDelete={async () =>
              orThrow(
                await client.DELETE("/admin/products/{id}", { params: { path: { id } } }),
              )
            }
            onDeleted={() => {
              // Away from an address that no longer resolves, and the list re-read behind it.
              void queries.invalidateQueries({ queryKey: [PRODUCT] });
              void navigate("/products", { replace: true });
            }}
            problemOf={(thrown) => whyNotDeleted(thrown, "The Product was not deleted.")}
          />
        </CardAction>
      </CardHeader>
      <form onSubmit={form.handleSubmit((values) => rename.mutate(values))}>
        <CardContent className="grid gap-4">
          <Problem
            problem={rename.isError ? whyNotChanged(rename.error) : null}
            title="The Product was not renamed."
          />
          <FormField
            id="product-title"
            label="Title"
            error={form.formState.errors.title}
            {...form.register("title")}
          />
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton
            type="submit"
            unavailable={unavailable}
            disabled={rename.isPending}
          >
            {rename.isPending ? <Spinner /> : null}
            Rename
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * The shape of a title, and only the shape (ADR-0063).
 *
 * `min(1)` is the field being required and not a claim about what kobai will accept. Whether a
 * title is any good is not a rule Core has, and one invented here would be one a Merchant
 * could not appeal.
 */
const RenameForm = z.object({
  title: z.string().min(1, "A Product needs a title."),
});

/**
 * One Variant: what it is, what is counted, what it costs, and what it previews at.
 *
 * A Variant is the sellable thing (ADR-0008), so every operation that is not about the Product
 * as a whole lands here — which is a lot of screen, and the reason it is broken into sections
 * with a `Separator` between them rather than into cards inside a card.
 */
function VariantCard({
  productId,
  variant,
}: {
  readonly productId: string;
  readonly variant: Variant;
}) {
  const client = useKobaiClient();
  const reread = useRereadProduct(productId);
  const unavailable = useCannotWrite();
  // Newest first is what the API answers with, so the head of the list is the Price a Merchant
  // most recently entered — the one worth comparing against.
  const newest = variant.prices[0] ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>
            Variant <code>{variant.sku}</code>
          </h3>
        </CardTitle>
        <CardDescription>
          Every Product has at least one Variant, and the Variant is what is sellable and
          what carries Prices (ADR-0008).
        </CardDescription>
        <CardAction>
          <ConfirmDelete
            trigger="Delete Variant"
            title="Delete this Variant?"
            description="Its Prices go with it. kobai refuses this if it is the Product's last Variant, or if stock is currently claimed by an Order being placed — you will be told here if so."
            unavailable={unavailable}
            onDelete={async () =>
              orThrow(
                await client.DELETE("/admin/variants/{id}", {
                  params: { path: { id: variant.id } },
                }),
              )
            }
            onDeleted={reread}
            problemOf={(thrown) => whyNotDeleted(thrown, "The Variant was not deleted.")}
          />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <VariantIdentity productId={productId} variant={variant} />

        <Separator />

        <Prices productId={productId} variant={variant} />

        <Separator />

        <Stock productId={productId} variant={variant} />

        <Separator />

        <StorefrontPrice
          variantId={variant.id}
          entered={newest ? { amount: newest.amount, currency: newest.currency } : null}
        />
      </CardContent>
    </Card>
  );
}

/**
 * What a Variant is: its SKU, and the Strategy it is delivered by.
 *
 * **The two are one form on purpose.** ADR-0062 settles both as corrections in place, and the
 * headline case for the second is repairing a Variant left pointing at a Strategy nobody
 * wired — a Merchant who has come here to do that will very often be fixing the SKU that came
 * with it. `PATCH` takes either or both, and a body naming neither is refused, which cannot
 * happen here because this form always names both.
 *
 * **The stock count does not move**, in either direction, and that is ADR-0062 rather than an
 * implementation detail: discarding it would throw away a number a Merchant went and counted,
 * and `consume` is guarded, so it could fail a Capture past `take-payment` and refund a Shopper
 * for a purchase that had already been made.
 */
function VariantIdentity({
  productId,
  variant,
}: {
  readonly productId: string;
  readonly variant: Variant;
}) {
  const client = useKobaiClient();
  const reread = useRereadProduct(productId);
  const unavailable = useCannotWrite();

  const form = useForm({
    resolver: zodResolver(IdentityForm),
    // `values` rather than `defaultValues`, so a correction that landed leaves both fields
    // showing what kobai now holds rather than what was typed at it.
    values: { sku: variant.sku, strategy: variant.fulfilment.strategy },
  });

  const correct = useMutation({
    mutationFn: async (values: { sku: string; strategy: string }) =>
      orThrow(
        await client.PATCH("/admin/variants/{id}", {
          params: { path: { id: variant.id } },
          body: { sku: values.sku, fulfilment: { strategy: values.strategy } },
        }),
      ),
    onSuccess: reread,
  });

  return (
    <form onSubmit={form.handleSubmit((values) => correct.mutate(values))}>
      <fieldset className="grid gap-4">
        <legend className="pb-2 font-medium text-sm">Identity</legend>

        <Problem
          problem={correct.isError ? whyNotChanged(correct.error) : null}
          title="The Variant was not corrected."
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            id={`variant-sku-${variant.id}`}
            label="SKU"
            error={form.formState.errors.sku}
            {...form.register("sku")}
          />
          <FulfilmentStrategyField
            id={`variant-strategy-${variant.id}`}
            current={variant.fulfilment.strategy}
            description="How this Variant is delivered. Swapping it is how a poster becomes a download; whatever stock has been counted stays counted (ADR-0062)."
            error={form.formState.errors.strategy}
            {...form.register("strategy")}
          />
        </div>

        <div>
          <ActionButton
            type="submit"
            unavailable={unavailable}
            disabled={correct.isPending}
          >
            {correct.isPending ? <Spinner /> : null}
            Save Variant
          </ActionButton>
        </div>
      </fieldset>
    </form>
  );
}

/**
 * What identifies a Variant and how it is delivered — the shape, and nothing else.
 *
 * A SKU is a required string here and no more than that: whether it is *taken* is a rule that
 * lives in Core and arrives as `sku-taken`. The Strategy is required for the same reason the
 * picker never offers a blank one — a Variant always points at something — and which names are
 * acceptable is kobai's answer, not this schema's.
 */
const IdentityForm = z.object({
  sku: z.string().min(1, "A Variant is identified by its SKU, so it needs one."),
  strategy: z.string().min(1, "A Variant is delivered by some Fulfilment Strategy."),
});

/**
 * Every Price on this Variant, the way to add one, and the way to take one away.
 *
 * **There is deliberately no way to edit an amount, because there is no route that does.** A
 * Price is a row (ADR-0008, ADR-0062): a correction is a *new* Price and then the removal of
 * the old one, in that order, and this screen must not imply otherwise. So the control is
 * called Supersede rather than Edit, and what it does is exactly the two calls in the order
 * that never leaves the Variant unquotable — the reverse, or a delete-then-insert repair,
 * both do.
 */
function Prices({
  productId,
  variant,
}: {
  readonly productId: string;
  readonly variant: Variant;
}) {
  const client = useKobaiClient();
  const reread = useRereadProduct(productId);
  const unavailable = useCannotWrite();

  const form = useForm<AmountInput, unknown, AmountValues>({
    resolver: zodResolver(AmountForm),
    defaultValues: { amount: "" },
  });

  const add = useMutation({
    mutationFn: async ({ amount }: AmountValues) =>
      orThrow(
        await client.POST("/admin/variants/{id}/prices", {
          params: { path: { id: variant.id } },
          body: { amount },
        }),
      ),
    onSuccess: () => form.reset(),
    onSettled: reread,
  });

  return (
    <fieldset className="grid gap-4">
      <legend className="pb-2 font-medium text-sm">Prices</legend>

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
              <TableHead className="w-0">
                {/* Named rather than empty: a header with no text is one a screen reader
                    announces as nothing at all. */}
                <span className="sr-only">Change this Price</span>
              </TableHead>
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
                <TableCell className="flex gap-2">
                  <Supersede
                    variantId={variant.id}
                    price={price}
                    unavailable={unavailable}
                    onDone={reread}
                  />
                  <ConfirmDelete
                    trigger="Delete"
                    title="Delete this Price?"
                    description="Removing the last Price on a Variant leaves it unquotable, so a storefront can no longer sell it. To correct a Price rather than remove it, supersede it instead."
                    unavailable={unavailable}
                    onDelete={async () =>
                      orThrow(
                        await client.DELETE("/admin/variants/{id}/prices/{priceId}", {
                          params: { path: { id: variant.id, priceId: price.id } },
                        }),
                      )
                    }
                    onDeleted={reread}
                    problemOf={(thrown) =>
                      whyNotDeleted(thrown, "The Price was not deleted.")
                    }
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <form onSubmit={form.handleSubmit((values) => add.mutate(values))}>
        <div className="grid items-end gap-4 sm:grid-cols-[1fr_auto]">
          <Problem
            className="sm:col-span-2"
            problem={add.isError ? whyNotChanged(add.error) : null}
            title="The Price was not added."
          />
          <FormField
            id={`variant-new-price-${variant.id}`}
            label="Add a Price, in minor units"
            inputMode="numeric"
            placeholder="1250"
            error={form.formState.errors.amount}
            {...form.register("amount")}
          />
          <ActionButton
            type="submit"
            variant="outline"
            unavailable={unavailable}
            disabled={add.isPending}
          >
            {add.isPending ? <Spinner /> : null}
            Add Price
          </ActionButton>
        </div>
      </form>
    </fieldset>
  );
}

/**
 * A Price replaced by a new one — added first, and only then is the old one removed.
 *
 * **The order is the whole of it.** Between the two calls the Variant carries both Prices,
 * which is a state ADR-0008 already allows and a storefront already resolves; the other order
 * leaves it carrying none, so a Shopper mid-checkout gets no quote for as long as the second
 * request takes. That window is small and it is avoidable for free, which is the kind kobai
 * does not ship (ADR-0018's reasoning, one layer up).
 *
 * **If the removal fails, the new Price stays.** That is the right way round: the Variant is
 * quotable at the new amount and carries a stale row a Merchant can see and delete, rather than
 * being rolled back to the amount they just decided was wrong. The refusal says so.
 */
function Supersede({
  variantId,
  price,
  unavailable,
  onDone,
}: {
  readonly variantId: string;
  readonly price: Price;
  readonly unavailable: string | null;
  readonly onDone: () => void;
}) {
  const client = useKobaiClient();
  const [open, setOpen] = useState(false);

  const form = useForm<AmountInput, unknown, AmountValues>({
    resolver: zodResolver(AmountForm),
    defaultValues: { amount: String(price.amount) },
  });

  const supersede = useMutation({
    mutationFn: async ({ amount }: AmountValues) => {
      // Added first. Everything after this point leaves the Variant quotable whatever happens.
      orThrow(
        await client.POST("/admin/variants/{id}/prices", {
          params: { path: { id: variantId } },
          body: { amount },
        }),
      );
      orThrow(
        await client.DELETE("/admin/variants/{id}/prices/{priceId}", {
          params: { path: { id: variantId, priceId: price.id } },
        }),
      );
    },
    onSuccess: () => setOpen(false),
    onSettled: onDone,
  });

  if (!open) {
    return (
      <ActionButton
        variant="outline"
        size="sm"
        unavailable={unavailable}
        onClick={() => {
          supersede.reset();
          form.reset({ amount: String(price.amount) });
          setOpen(true);
        }}
      >
        Supersede
      </ActionButton>
    );
  }

  return (
    <form
      className="grid gap-2"
      onSubmit={form.handleSubmit((values) => supersede.mutate(values))}
    >
      <FormField
        id={`supersede-${price.id}`}
        label="New amount, in minor units"
        inputMode="numeric"
        error={form.formState.errors.amount}
        {...form.register("amount")}
      />
      <Problem
        problem={supersede.isError ? whyNotSuperseded(supersede.error) : null}
        title="The Price was not superseded."
      />
      <div className="flex gap-2">
        <ActionButton
          type="submit"
          size="sm"
          unavailable={unavailable}
          disabled={supersede.isPending}
        >
          {supersede.isPending ? <Spinner /> : null}
          Replace Price
        </ActionButton>
        <ActionButton
          type="button"
          size="sm"
          variant="outline"
          unavailable={null}
          disabled={supersede.isPending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </ActionButton>
      </div>
    </form>
  );
}

/**
 * An amount, as a whole number of minor units — the shape and nothing else (ADR-0063).
 *
 * Parsed rather than coerced from a blank: an `<input>` hands over a string, so an empty one
 * has to be caught before `Number("")` turns it into a free Variant. Whether kobai will accept
 * the number — negative, absurd, in a currency this Store does not price in — is Core's answer
 * and arrives as a refusal.
 */
const AmountForm = z.object({
  amount: z
    .string()
    .min(1, "A Price is a whole number of minor units — 1250 is 12.50.")
    .transform((typed) => Number(typed))
    .pipe(
      z
        .number("A Price is a whole number of minor units — 1250 is 12.50.")
        .int("Minor units are whole: 1250, not 12.50."),
    ),
});

type AmountInput = z.input<typeof AmountForm>;
type AmountValues = z.output<typeof AmountForm>;

/**
 * What the Store has of this Variant, what is left to sell, and the way to say so (ADR-0018).
 *
 * **Untracked is `null` and says so in words**, because it is not the same as none left: a
 * Variant nobody counts sells freely, and a Merchant looking at a blank number would have no way
 * to tell which of the two they were looking at.
 *
 * `reserved` is shown beside `available` rather than folded into it. It is the stock claimed by
 * Orders currently being placed, so a Merchant who sees fewer available than they counted has the
 * explanation in the same row instead of a discrepancy to chase.
 *
 * **The form sets `onHand` and nothing else**, because `reserved` is not a Merchant's to set —
 * it is what Reservations are holding — and `available` is the subtraction of the two. A count
 * *replaces* what was there rather than adding to it, which is what `PUT` means and what the
 * label has to say, or a Merchant who counted five more will set the shelf to five.
 */
function Stock({
  productId,
  variant,
}: {
  readonly productId: string;
  readonly variant: Variant;
}) {
  const client = useKobaiClient();
  const reread = useRereadProduct(productId);
  const unavailable = useCannotWrite();
  const inventory = variant.inventory;

  const form = useForm<CountInput, unknown, CountValues>({
    resolver: zodResolver(CountForm),
    values: { onHand: inventory === null ? "" : String(inventory.onHand) },
  });

  const count = useMutation({
    mutationFn: async ({ onHand }: CountValues) =>
      orThrow(
        await client.PUT("/admin/variants/{id}/inventory", {
          params: { path: { id: variant.id } },
          body: { onHand },
        }),
      ),
    // Re-read rather than patched: `available` is `onHand - reserved`, and `reserved` is a
    // number this browser does not hold and cannot predict (ADR-0063).
    onSuccess: reread,
  });

  return (
    <fieldset className="grid gap-4">
      <legend className="pb-2 font-medium text-sm">Stock</legend>

      {inventory === null ? (
        <p className="text-muted-foreground text-sm">
          Nobody is counting this Variant, so it sells freely — which is not the same as
          having none left. Counting it starts.
        </p>
      ) : (
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
      )}

      <form onSubmit={form.handleSubmit((values) => count.mutate(values))}>
        <div className="grid items-end gap-4 sm:grid-cols-[1fr_auto]">
          <Problem
            className="sm:col-span-2"
            problem={count.isError ? whyNotChanged(count.error) : null}
            title="The count was not set."
          />
          <FormField
            id={`variant-on-hand-${variant.id}`}
            label="On hand — what the Store has, counted"
            inputMode="numeric"
            placeholder="0"
            error={form.formState.errors.onHand}
            {...form.register("onHand")}
          />
          <ActionButton
            type="submit"
            variant="outline"
            unavailable={unavailable}
            disabled={count.isPending}
          >
            {count.isPending ? <Spinner /> : null}
            Set count
          </ActionButton>
        </div>
      </form>
    </fieldset>
  );
}

/**
 * A count, as a whole number that is not negative.
 *
 * Negative is checked here and it is the one place this file goes past pure structure, because
 * `onHand` is `minimum: 0` in kobai's own schema — so this is the *shape* of the field rather
 * than a rule invented for it, and kobai still refuses one that slips past.
 */
const CountForm = z.object({
  onHand: z
    .string()
    .min(1, "A count is a whole number — 0 for none.")
    .transform((typed) => Number(typed))
    .pipe(
      z
        .number("A count is a whole number — 0 for none.")
        .int("A count is whole: 5, not 5.5.")
        .min(0, "A count cannot be negative."),
    ),
});

type CountInput = z.input<typeof CountForm>;
type CountValues = z.output<typeof CountForm>;

/**
 * A second Variant on a Product that already exists — a second size, a second colour.
 *
 * `POST /admin/products/{id}/variants` is the route #172 built for exactly this, and the reason
 * it is addressed through the Product is that a Variant belongs to one and there is nowhere
 * else to hang it. It carries no Price: a Price is a row on the Variant, added after it exists,
 * which is the same two steps creating a Product takes.
 */
function NewVariant({ productId }: { readonly productId: string }) {
  const client = useKobaiClient();
  const reread = useRereadProduct(productId);
  const unavailable = useCannotWrite();

  const form = useForm({
    resolver: zodResolver(IdentityForm),
    defaultValues: { sku: "", strategy: DEFAULT_STRATEGY },
  });

  const add = useMutation({
    mutationFn: async (values: { sku: string; strategy: string }) =>
      orThrow(
        await client.POST("/admin/products/{id}/variants", {
          params: { path: { id: productId } },
          body: { sku: values.sku, fulfilment: { strategy: values.strategy } },
        }),
      ),
    onSuccess: () => form.reset(),
    onSettled: reread,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Add a Variant</h3>
        </CardTitle>
        <CardDescription>
          A second size or colour of this Product. It gets a Price of its own once it
          exists — a Price is a row on the Variant (ADR-0008).
        </CardDescription>
      </CardHeader>
      <form onSubmit={form.handleSubmit((values) => add.mutate(values))}>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Problem
            className="sm:col-span-2"
            problem={add.isError ? whyNotChanged(add.error) : null}
            title="The Variant was not added."
          />
          <FormField
            id="new-variant-sku"
            label="SKU"
            error={form.formState.errors.sku}
            {...form.register("sku")}
          />
          <FulfilmentStrategyField
            id="new-variant-strategy"
            current={DEFAULT_STRATEGY}
            error={form.formState.errors.strategy}
            {...form.register("strategy")}
          />
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton type="submit" unavailable={unavailable} disabled={add.isPending}>
            {add.isPending ? <Spinner /> : null}
            Add Variant
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * What a new Variant points at when nobody chooses.
 *
 * **This is not the Admin writing down the set**, which is the thing `FulfilmentStrategyField`
 * exists to stop: it is `CreateVariantRequest`'s own documented default — "Defaults to
 * `physical`" — which is promised surface under ADR-0060, so agreeing with it is reading kobai
 * rather than guessing at it. Sending the same word the route would have applied to an absent
 * `fulfilment` is what makes the picker's initial state honest.
 *
 * The alternative was to start on the first name the list answers with. That is alphabetical,
 * so a new Variant would default to `digital` — a different Variant from the one the same
 * request without this field would create, which is a worse kind of wrong than a constant.
 *
 * A deployment that *replaced* `physical` still has something wired under the name, because
 * replacing is what naming one of Core's in `kobai.config.ts` does.
 */
const DEFAULT_STRATEGY = "physical";

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
 * Why kobai refused a **deletion**, in words a Merchant can act on.
 *
 * `CatalogRefusal` is the busiest closed family the Admin touches — ten reasons — and this is
 * where #174's exhaustive narrowing earns its keep: **a reason added to it in Core has no arm
 * here and reddens this build in the same commit** (ADR-0063). That is the value of the
 * `never` at the bottom; it is not that every reason deserves its own copy.
 *
 * The two that matter are ADR-0059's, and both are *rendered inside the dialog the deletion
 * was attempted from*. Neither is predicted: the Admin has no opinion on whether stock is
 * reserved, because that is a rule living in Core which Core may change and which a
 * Developer's Project may already have changed through a replaced Step.
 */
function whyNotDeleted(thrown: unknown, fallback: string): string {
  const reason = catalogReasonOf(thrown);

  switch (reason) {
    case "last-variant":
      return "A Product is only sellable through a Variant, so kobai will not remove its last one. Delete the Product instead, or add another Variant first.";

    case "stock-is-reserved":
      return "Stock for this Variant is claimed by an Order being placed right now, and those units are not yours to take away mid-purchase. Try again once the Order has settled or its hold has lapsed.";

    case "product-not-found":
    case "variant-not-found":
    case "price-not-found":
      return "It is already gone — somebody else deleted it, or this page has been open a while.";

    case "invalid":
    case "malformed-body":
    case "sku-taken":
    case "unsupported-currency":
    case "unknown-fulfilment-strategy":
      // Not reachable from a delete, which sends no body and names no SKU, currency or
      // Strategy. Reported as kobai said it rather than as a sentence written for a case
      // nobody has seen.
      return problemOf(thrown, fallback);

    case undefined:
      // A 500, which carries no `reason` on purpose, or the network being gone.
      return fallback;

    default: {
      const unreached: never = reason;
      return unreached;
    }
  }
}

/**
 * Why kobai refused a **change** — a rename, a correction, a Price, a count.
 *
 * One narrowing for the writes rather than one per form, because they refuse through the same
 * family and mostly with the same words: what a Merchant needs told is `sku-taken`, and what
 * they need told about a Strategy is that the deployment does not have it. Everything else is
 * kobai's own prose, which names the field and is more than any of these forms knows.
 *
 * Exhaustive for the same reason as above, and by the same mechanism.
 */
function whyNotChanged(thrown: unknown): string {
  const fallback = "kobai would not make that change.";
  const reason = catalogReasonOf(thrown);

  switch (reason) {
    case "sku-taken":
      return "Another Variant already carries that SKU. A SKU is what identifies a Variant, so this one needs its own.";

    case "unknown-fulfilment-strategy":
      // kobai's prose lists the ones it *does* have, which is exactly what is wanted here and
      // is a set this browser could be holding a stale copy of.
      return problemOf(thrown, fallback);

    case "product-not-found":
    case "variant-not-found":
      return "It is no longer there — somebody else deleted it, or this page has been open a while.";

    case "unsupported-currency":
      return "This Store does not price in that currency. Every Price carries the Store's default and no other (ADR-0065).";

    case "invalid":
    case "malformed-body":
      // kobai's own prose names the field, which is more than this screen knows.
      return problemOf(thrown, fallback);

    case "price-not-found":
    case "last-variant":
    case "stock-is-reserved":
      // Deletion's refusals, not reachable from a form that changes something.
      return problemOf(thrown, fallback);

    case undefined:
      // A 500, which carries no `reason` on purpose, or the network being gone.
      return fallback;

    default: {
      const unreached: never = reason;
      return unreached;
    }
  }
}

/**
 * Why superseding did not complete, which is two calls and so has a case neither has alone.
 *
 * `price-not-found` here means the **new Price was written and the old one was not removed** —
 * somebody deleted it in between, or this page had been open a while. That is not a failure a
 * Merchant should be told to retry: the Variant is priced at the new amount, which is what they
 * asked for, and there is nothing left to remove.
 */
function whyNotSuperseded(thrown: unknown): string {
  return catalogReasonOf(thrown) === "price-not-found"
    ? "The new Price was added. The old one was already gone, so nothing was left to remove."
    : whyNotChanged(thrown);
}
