import { zodResolver } from "@hookform/resolvers/zod";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { PackageIcon } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ActionButton } from "@/components/action-button";
import { FormField } from "@/components/form-field";
import { LinkButton } from "@/components/link-button";
import { ListFilter, useListFilter } from "@/components/list-filter";
import { Pager, usePageCursor } from "@/components/pager";
import { Problem } from "@/components/problem";
import {
  OFFERED_STATUSES,
  PRODUCT_STATUS_LABELS,
  PRODUCT_STATUS_OPTIONS,
  ProductStatusBadge,
} from "@/components/product-status-badge";
import {
  Card,
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
import { slugify } from "@/lib/handle";
import { PERMISSIONS, useUnavailable } from "@/lib/permissions";
import { catalogReasonOf, orThrow, problemOf, Refused } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/**
 * The Products this Merchant has created (spec story 22), a page at a time.
 *
 * `GET /admin/products` answers newest first and pages by cursor (ADR-0064), and **the cursor
 * this page was asked for is in the URL** — so a page is a link, a refresh lands on it, and the
 * back button walks back through the pages. `components/pager.tsx` owns that; this screen owns
 * what a page of Products looks like.
 *
 * Everything is read through TanStack Query, keyed by the cursor, so paging back is the cache
 * answering rather than a second round trip. There is no optimistic update anywhere in this
 * Admin (ADR-0063): creating a Product invalidates the list and the list is re-read, because
 * what a Product looks like once kobai has it — its identifier, its Variants — is kobai's
 * answer and not something a browser can predict correctly.
 */
const PRODUCTS = "products";

/** The query parameter the filter lives in, spelled as `GET /admin/products` spells it. */
const STATUS = "status";

/** Where this section lives, exactly as `app.tsx` and `lib/sections.ts` spell it. */
const HERE = "/products";

export function Products() {
  const client = useKobaiClient();
  const after = usePageCursor();
  const { asked, value: status, unknownValue } = useListFilter(STATUS, OFFERED_STATUSES);

  const page = useQuery({
    // The cursor is part of the key, so each page is cached as itself — and so is the filter
    // beside it, because a page of drafts and a page of published Products are two different
    // answers to two different questions.
    //
    // Keyed on what the **address** asked for rather than on the status it narrowed to, so that
    // a word kobai does not have is its own key rather than the unfiltered catalog's.
    queryKey: [PRODUCTS, asked, after ?? null],
    queryFn: async () =>
      orThrow(
        await client.GET("/admin/products", {
          params: {
            query: {
              // Each omitted rather than sent empty. An empty `after` is a cursor kobai never
              // issued and is refused as one, and an empty `status` is not one of the three.
              ...(after === undefined ? {} : { after }),
              ...(status === undefined ? {} : { status }),
            },
          },
        }),
      ),
    // The previous page stays on screen while the next one is fetched, so moving through a
    // list is a spinner over what you were reading rather than the whole table disappearing.
    placeholderData: keepPreviousData,
    // Nothing is asked for while the address names a status kobai has never heard of: the
    // screen has an answer already, and it is not one kobai could improve on.
    enabled: unknownValue === null,
  });

  // Nothing at all while the address names no status kobai has, and that is the assertion
  // rather than a tidiness: `placeholderData` hands this observer the page it was last showing
  // while a new key is in flight, so a screen that read `page.data` here would print "no such
  // status" over the rows of whichever filter the Merchant came from.
  const products = unknownValue === null ? page.data?.products : undefined;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Products
            {/* A refetch, which is a different thing from a first load — and the first load
                has a skeleton of its own below. */}
            {page.isFetching && !page.isPending ? <Spinner /> : null}
          </CardTitle>
          <CardDescription>
            Everything this Store sells, newest first. Open one to see its Variant, its
            Price, and the price a storefront would receive.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ListFilter
            label="Filter the Products"
            section={HERE}
            parameter={STATUS}
            asked={asked}
            options={PRODUCT_STATUS_OPTIONS}
          />

          <Problem
            problem={
              page.isError
                ? problemOf(page.error, "The Products could not be read.")
                : null
            }
          />

          {unknownValue === null ? null : <NoSuchStatus asked={unknownValue} />}

          {page.isPending && unknownValue === null ? <ProductsLoading /> : null}

          {products !== undefined && products.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PackageIcon />
                </EmptyMedia>
                <EmptyTitle>
                  {status === undefined
                    ? "No Products yet"
                    : `No ${PRODUCT_STATUS_LABELS[status].toLowerCase()} Products`}
                </EmptyTitle>
                <EmptyDescription>
                  {/* Which of the two sentences this is matters: "there is nothing here"
                      and "there is nothing here *in this status*" are different facts, and
                      a filtered list saying the first would send a Merchant looking for a
                      catalog they still have. */}
                  {status === undefined
                    ? "Nothing is for sale until a Product exists. Create one below — a title, a SKU and a Price is the thinnest sellable thing."
                    : "Nothing in this Store is in that status. Choose All above to see the whole catalog."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}

          {products !== undefined && products.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  {/* Beside the title rather than only on the Product screen: the address is
                      what a storefront links to, so scanning for the one that is wrong is a
                      thing a Merchant does across the whole catalog. */}
                  <TableHead>Handle</TableHead>
                  {/* Beside the handle, because it is the other thing that decides whether a
                      storefront can reach this Product at all: an address nothing publishes is
                      an address that answers 404. */}
                  <TableHead>Status</TableHead>
                  {/* Named rather than empty: a column header with no text is a column a
                      screen reader announces as nothing at all. */}
                  <TableHead className="w-0">
                    <span className="sr-only">Open</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((product) => (
                  <TableRow key={product.id}>
                    <TableCell className="font-medium">{product.title}</TableCell>
                    <TableCell className="text-muted-foreground">
                      /{product.handle}
                    </TableCell>
                    <TableCell>
                      <ProductStatusBadge status={product.status} />
                    </TableCell>
                    <TableCell>
                      <LinkButton
                        to={`/products/${product.id}`}
                        size="sm"
                        variant="outline"
                      >
                        Open
                      </LinkButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}

          <Pager nextCursor={page.data?.nextCursor} label="Products" />
        </CardContent>
      </Card>

      <NewProduct />
    </div>
  );
}

/**
 * An address naming a status kobai does not have.
 *
 * Only ever reached by typing or by following a stale link, and it says so rather than quietly
 * showing every Product — a filter that was dropped answers a different question from the one
 * that was asked, and a Merchant reading the whole catalog would not know it had been. kobai
 * refuses this word too, with `invalid`; this screen is what stops the round trip being needed
 * to find out.
 */
function NoSuchStatus({ asked }: { readonly asked: string }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PackageIcon />
        </EmptyMedia>
        <EmptyTitle>No such Product status</EmptyTitle>
        <EmptyDescription>
          kobai knows no Product status called “{asked}”. A Product is a draft, published
          or archived, and the three above are the whole of it.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * A page of Products, before there is one.
 *
 * A skeleton in the shape of the table it is standing in for, rather than the words "Reading
 * the catalog…" this screen used to show. Both say "wait"; only one says how much is coming.
 */
function ProductsLoading() {
  return (
    <div className="grid gap-3" role="status" aria-label="Reading the Products">
      {["first", "second", "third"].map((row) => (
        <Skeleton key={row} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * The shape of the form, and **only** the shape.
 *
 * It mirrors `contract.ts`'s structure — that a title and a SKU are strings, that an amount is
 * a whole number of minor units — and re-implements no rule (ADR-0063). Whether that SKU is
 * already taken, whether this Store prices in that currency, whether the amount is one kobai
 * will accept: every one of those lives in Core, may change there, and arrives here as a
 * refusal. A schema that guessed at them would be a second, stale copy of Core's rules that a
 * Merchant could not appeal.
 *
 * `min(1)` on the two strings is the field being **required** — what the `required` attribute
 * said before there was a schema — and not a claim about what kobai will accept.
 *
 * The amount is parsed rather than coerced from a blank: an `<input>` hands over a string, so
 * an empty one has to be caught before `Number("")` turns it into a free Product.
 */
const NewProductForm = z.object({
  title: z.string().min(1, "A Product needs a title."),
  // No `min(1)`, and no shape: an empty box is a Merchant taking kobai's proposal, and what a
  // handle may look like is a rule Core owns and may relax — one restated here would be a
  // second, stale copy a Merchant could not appeal (ADR-0063).
  handle: z.string(),
  sku: z.string().min(1, "A Variant is identified by its SKU, so it needs one."),
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

type NewProductInput = z.input<typeof NewProductForm>;
type NewProductValues = z.output<typeof NewProductForm>;

/**
 * A Product that was created and then not priced.
 *
 * Creating one is two calls — a Product with its Variant, then a Price on that Variant — and
 * the second failing leaves a real Product in the catalog with nothing to sell it at. That is
 * a different sentence from "the Product could not be created", so it is a different type; it
 * extends {@link Refused} so the refusal it carries still narrows like any other.
 */
class NotPriced extends Refused {}

/**
 * Creating the thinnest sellable thing.
 *
 * No acceptance criterion asks for creation, and it is here because the criteria that *are*
 * asked for cannot otherwise be seen: a Merchant on a fresh deployment would have to reach for
 * `curl` before the Admin could list anything, price anything, or show a resolved price
 * differing from an entered one.
 *
 * **It is shown to a Role that cannot use it, unavailable and explained** (ADR-0063). Hiding
 * the form would leave a Merchant who may read the catalog with no way to learn that Products
 * are creatable at all, and so no way to know what to ask for. None of this is a boundary:
 * `POST /admin/products` is gated by `catalog:write` in Core, and `lib/permissions.ts` is where
 * that distinction is written down.
 */
function NewProduct() {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const unavailable = useUnavailable(PERMISSIONS.catalogWrite, "create a Product");

  const form = useForm<NewProductInput, unknown, NewProductValues>({
    resolver: zodResolver(NewProductForm),
    defaultValues: { title: "", handle: "", sku: "", amount: "" },
  });

  // The proposal, and the whole of it: while the Merchant has not touched the handle box it
  // shows what this title would be addressed at, and the moment they do it is theirs. It is an
  // affordance rather than a rule — kobai proposes the same handle for a create that names
  // none, and judges whatever is sent (`lib/handle.ts`).
  //
  // **On the title's own `onChange` rather than on a `watch`.** Typing is what causes it, so
  // this is one write per keystroke in the handler that keystroke already runs, rather than a
  // subscription plus a write during render — which is a store mutation mid-render and a
  // correctness that rested on the re-render happening to come from the right place.
  const proposeFromTitle = (typed: string) => {
    // `shouldDirty: false`, so this stays the proposal rather than becoming an answer the
    // Merchant is treated as having given — which is also what `isDirty` reads to know when to
    // stop.
    if (form.getFieldState("handle").isDirty) return;
    form.setValue("handle", slugify(typed), { shouldDirty: false });
  };

  const create = useMutation({
    mutationFn: async ({ title, handle, sku, amount }: NewProductValues) => {
      // A Product and its Variants are created together: a Product with no Variant is not a
      // state the API can produce, because a Product is never sellable in itself (ADR-0008).
      const product = orThrow(
        await client.POST("/admin/products", {
          body: {
            title,
            // Left out rather than sent empty when the box is empty, which is what asks kobai
            // to propose one. `""` is a handle, and not one it would accept.
            ...(handle === "" ? {} : { handle }),
            variants: [{ sku }],
          },
        }),
      );

      const variant = product.variants[0];
      if (!variant) throw new Error("kobai created a Product with no Variant.");

      // A Price is a row on the Variant, added second and separately — which is what makes a
      // sale price or a second currency more rows later rather than a migration (ADR-0008).
      const priced = await client.POST("/admin/variants/{id}/prices", {
        params: { path: { id: variant.id } },
        body: { amount },
      });
      if (priced.error !== undefined) throw new NotPriced(priced.error);

      return product;
    },
    onSuccess: () => form.reset(),
    // Whichever half failed, a Product may now exist — so the list is re-read either way, and
    // it is re-read rather than patched in place, which is what "no optimistic updates" means.
    onSettled: () => queries.invalidateQueries({ queryKey: [PRODUCTS] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>New Product</CardTitle>
        <CardDescription>
          One Product, one Variant, one Price — the thinnest sellable thing.
        </CardDescription>
      </CardHeader>
      {/* No guard of its own, deliberately: a browser performs the implicit submission of
          Enter in a field by clicking this form's default button, which is the `ActionButton`
          below — so the one no-op covers both ways in. */}
      <form onSubmit={form.handleSubmit((values) => create.mutate(values))}>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Problem
            className="sm:col-span-2"
            problem={create.isError ? whyNotCreated(create.error) : null}
          />

          <FormField
            id="new-product-title"
            label="Title"
            error={form.formState.errors.title}
            {...form.register("title", {
              onChange: (event: { target: { value: string } }) =>
                proposeFromTitle(event.target.value),
            })}
          />
          <FormField
            id="new-product-handle"
            label="Handle"
            description="The address a storefront reaches this Product at — /products/blue-poster. Proposed from the title as you type; change it and it is yours. Left empty, kobai proposes one itself."
            error={form.formState.errors.handle}
            {...form.register("handle")}
          />
          <FormField
            id="new-product-sku"
            label="SKU"
            error={form.formState.errors.sku}
            {...form.register("sku")}
          />
          <FormField
            id="new-product-amount"
            label="Price, in minor units"
            inputMode="numeric"
            placeholder="1250"
            error={form.formState.errors.amount}
            {...form.register("amount")}
          />
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton
            type="submit"
            unavailable={unavailable}
            disabled={create.isPending}
          >
            {create.isPending ? <Spinner /> : null}
            Create
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * Why kobai turned the creation back, in words a Merchant can act on.
 *
 * **Every `reason` `CatalogRefusal` carries has an arm here, and the `never` at the bottom is
 * what makes that true** — a reason added to that family in Core reddens this build in the
 * same commit rather than falling through to a message that no longer fits (ADR-0063). That is
 * the value of the exhaustiveness; it is not that every reason deserves its own copy. Most of
 * these cannot arrive at this form at all — it sends no currency, names no Fulfilment Strategy
 * and deletes nothing — so they show the prose kobai itself sent, which is what a refusal from
 * a route this screen did not expect should say.
 *
 * Nothing here is *predicted*: the form is submitted and the answer is rendered. Asking whether
 * a SKU is free before submitting would put a rule in the Admin that lives in Core, and Core
 * may change it — or a Developer's Project may already have, through a replaced Step.
 */
function whyNotCreated(thrown: unknown): string {
  const fallback =
    thrown instanceof NotPriced
      ? "The Product was created, but the Price was not."
      : "The Product could not be created.";

  const reason = catalogReasonOf(thrown);

  switch (reason) {
    case "sku-taken":
      return "Another Variant already carries that SKU. A SKU is what identifies a Variant, so this one needs its own.";

    case "handle-taken":
      // Rendered where it was attempted, like every other refusal here — and it is the one a
      // Merchant meets without asking for anything unusual, because two Products with the same
      // title propose the same address.
      return "Another Product is already reached at that handle. A handle is the address a storefront links to, so it cannot name two — give this one its own.";

    case "invalid":
    case "malformed-body":
      // kobai's own prose names the field, which is more than this screen knows.
      return problemOf(thrown, fallback);

    case "unsupported-currency":
    case "unknown-fulfilment-strategy":
    case "product-not-found":
    case "variant-not-found":
    case "price-not-found":
    case "last-variant":
    case "stock-is-reserved":
    case "variant-options-mismatch":
      // Not reachable from this form as it stands — it declares no options, so the Variant it
      // creates answers none. Options are declared on the Product screen, where a Variant is
      // also where its values are given. Reported as kobai said it rather than as a sentence
      // written here for a case nobody has seen.
      return problemOf(thrown, fallback);

    case undefined:
      // A 500, which carries no `reason` on purpose, or the network being gone.
      return fallback;

    default: {
      // Unreachable, and it is the compiler that says so: a `reason` with no arm above lands
      // here, and `never` does not accept it.
      const unreached: never = reason;
      return unreached;
    }
  }
}
