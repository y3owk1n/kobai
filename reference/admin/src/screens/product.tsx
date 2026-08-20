import { zodResolver } from "@hookform/resolvers/zod";
import type {
  Collection,
  Media,
  Price,
  ProductOption,
  ProductStatus,
  Variant,
  VariantOptionValue,
} from "@kobai/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageXIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { z } from "zod";
import { ActionButton } from "@/components/action-button";
import { CollectionsField } from "@/components/collections-field";
import { ComboboxField } from "@/components/combobox-field";
import { ConfirmDelete } from "@/components/confirm-delete";
import { FormField } from "@/components/form-field";
import { FulfilmentStrategyField } from "@/components/fulfilment-strategy-field";
import { LinkButton } from "@/components/link-button";
import { ListboxField } from "@/components/listbox-field";
import { MediaAttachments } from "@/components/media-attachments";
import { Problem } from "@/components/problem";
import {
  OFFERED_STATUSES,
  PRODUCT_STATUS_LABELS,
} from "@/components/product-status-badge";
import { StorefrontPrice } from "@/components/storefront-price";
import { TextareaField } from "@/components/textarea-field";
import { Button } from "@/components/ui/button";
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
import {
  useOfferedChannels,
  useOfferedRegions,
  whyChannelsNotRead,
  whyRegionsNotRead,
} from "@/lib/markets";
import { formatAmount } from "@/lib/money";
import { PERMISSIONS, useUnavailable } from "@/lib/permissions";
import { catalogReasonOf, orThrow, problemOf } from "@/lib/refusal";
import { useRouteId } from "@/lib/route";
import { useKobaiClient } from "@/lib/session";
import { useEnabledCurrencies, whyCurrenciesNotRead } from "@/lib/store";

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

      <ProductIdentity
        id={id}
        title={product.data.title}
        description={product.data.description}
        handle={product.data.handle}
        status={product.data.status}
      />

      <ProductOptions id={id} options={product.data.options} />

      <ProductMedia id={id} media={product.data.media} />

      <ProductCollections id={id} collections={product.data.collections} />

      {product.data.variants.map((variant) => (
        <VariantCard
          key={variant.id}
          productId={id}
          variant={variant}
          options={product.data.options}
          status={product.data.status}
        />
      ))}

      <NewVariant productId={id} options={product.data.options} />
    </div>
  );
}

/**
 * The Product itself: what it is called, what it says for itself, and the way to take it out of
 * the catalog.
 *
 * A `PATCH` naming the title and the description and **not** `metadata`, because that bag is
 * *replaced* rather than merged and a form that sent an empty object would silently discard
 * whatever a Project stashed there (ADR-0062). Editing metadata is a screen nobody has asked
 * for; sending it blank is data loss.
 *
 * **An empty description box is sent as `null`, which is what takes the copy back off.** The
 * two are one state in kobai — a Product nobody has written about holds `null` and never `""`
 * — so a box a Merchant emptied has to say so in the one spelling the route accepts, and a
 * `""` would be refused rather than stored. It is also why the box shows `""` for a Product
 * with no description: a `null` in a text field is React's uncontrolled-input warning, and
 * what a Merchant sees either way is an empty box.
 *
 * **The handle has no such spelling and is sent as it stands.** There is no `null` for it in
 * the route, because a Product with no address is not a state kobai has — so an emptied box is
 * a request kobai refuses at the field, exactly as an address somebody else holds is. Nothing
 * proposes one here either: a proposal belongs where a Product is being *named*, and rewriting
 * a live address because a Merchant fixed a typo in the title is the last thing this screen
 * should do.
 */
function ProductIdentity({
  id,
  title,
  description,
  handle,
  status,
}: {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly handle: string;
  readonly status: ProductStatus;
}) {
  const client = useKobaiClient();
  // Both, because deleting a Product invalidates more than the Product: the list behind it is
  // stale too, and that is the whole `[PRODUCT]` family rather than this one's key.
  const queries = useQueryClient();
  const reread = useRereadProduct(id);
  const navigate = useNavigate();
  const unavailable = useCannotWrite();

  const form = useForm({
    resolver: zodResolver(ProductForm),
    // Keyed by the values it was opened with, so a change that landed leaves the fields showing
    // what kobai now holds rather than what was typed.
    values: { title, description: description ?? "", handle, status },
  });

  const save = useMutation({
    mutationFn: async (values: {
      title: string;
      description: string;
      handle: string;
      status: ProductStatus;
    }) =>
      orThrow(
        await client.PATCH("/admin/products/{id}", {
          params: { path: { id } },
          body: {
            title: values.title,
            // Emptied means removed, and `null` is the only way to say it: an absent field
            // means "leave it" on every `PATCH` in kobai (ADR-0062).
            description: values.description.trim() === "" ? null : values.description,
            handle: values.handle,
            status: values.status,
          },
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
          one and correcting a typo rewrites nothing already sold (ADR-0009). The
          description is what a Shopper reads: a storefront is served it beside the title.
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
      <form onSubmit={form.handleSubmit((values) => save.mutate(values))}>
        <CardContent className="grid gap-4">
          <Problem
            problem={save.isError ? whyNotChanged(save.error) : null}
            title="The Product was not changed."
          />
          <FormField
            id="product-title"
            label="Title"
            error={form.formState.errors.title}
            {...form.register("title")}
          />
          <FormField
            id="product-handle"
            label="Handle"
            error={form.formState.errors.handle}
            description="The address a storefront reaches this Product at — /products/blue-poster. Changing it moves that address: anything already linking to the old one stops resolving."
            {...form.register("handle")}
          />
          <TextareaField
            id="product-description"
            label="Description"
            rows={4}
            error={form.formState.errors.description}
            description="What this Product says for itself, in your own words. Optional: a Product with an empty box here has no description at all, and emptying it removes the one it had."
            {...form.register("description")}
          />
          {/* Where a Product is published and where it is archived — the whole of stories 6
              and 7, and one field rather than a pair of buttons, because kobai answers them
              with one. `ListboxField` rather than a `Select` composed here, since it is the
              third picker on this frame and the first two had every defect #239 found fixed
              twice by hand (#245). No `unlisted`: a Product is always on one of the three, and
              the three are closed in kobai's own types. */}
          <ListboxField
            id="product-status"
            control={form.control}
            name="status"
            label="Status"
            options={OFFERED_STATUSES.map((one) => ({
              value: one,
              label: PRODUCT_STATUS_LABELS[one],
            }))}
            description="Whether a Shopper can see this Product. A draft is yours to prepare; publishing puts it on the storefront; archiving takes it off again and leaves every Order placed from it exactly as it was."
          />
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton type="submit" unavailable={unavailable} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save Product
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * The shape of what a Product says about itself, and only the shape (ADR-0063).
 *
 * `min(1)` on the title is the field being required and not a claim about what kobai will
 * accept. Whether a title is any good is not a rule Core has, and one invented here would be
 * one a Merchant could not appeal — which is also why the description carries no length at
 * either end: an empty box is a Product with no description, not a form error.
 */
const ProductForm = z.object({
  title: z.string().min(1, "A Product needs a title."),
  description: z.string(),
  // `min(1)` is the field being required, and it is required because there is no way to say
  // "remove the handle": kobai has no state for a Product with no address. What a handle may
  // *look* like stays kobai's rule, and arrives here as a refusal.
  handle: z.string().min(1, "A Product is reached at a handle, so it needs one."),
  // The three kobai has, as an enum rather than a string: this is one of the sets kobai's own
  // types close, so the Admin may hold it — the rule `lib/refusal.ts`'s `Record`s follow, and
  // the opposite of the Fulfilment Strategy picker, whose set a deployment decides (ADR-0063).
  status: z.enum(OFFERED_STATUSES),
});

/**
 * The options this Product is chosen by — Size, Colour — and the order they are offered in.
 *
 * **One form over the whole list, because kobai takes the whole list.** `PATCH
 * /admin/products/{id}` reads `options` as what the Product's options should now *be*: an entry
 * carrying an `id` is the option that already has it, one without is new, and one this Product
 * has that the list does not name is removed with every Variant's value for it. So renaming,
 * reordering, adding and removing are the same request, and this screen is a list a Merchant
 * edits rather than four controls.
 *
 * **Adding one leaves every Variant below it unanswered, and that is not hidden.** kobai does
 * not refuse the addition — refusing it would be a dead end, since the only way out would be to
 * rebuild the Product — so the Variant cards are where each one is given its value, and each
 * says so with an empty required field. Nothing here predicts that: the list is saved and the
 * Variants re-read, exactly as every other write on this screen does (ADR-0063).
 *
 * **The order is the list's own order**, so there is no position to type and nothing to keep in
 * step: Move up and Move down rearrange the rows, and saving is what makes that the Product's
 * order.
 */
function ProductOptions({
  id,
  options,
}: {
  readonly id: string;
  readonly options: readonly ProductOption[];
}) {
  const client = useKobaiClient();
  const reread = useRereadProduct(id);
  const unavailable = useCannotWrite();

  const form = useForm({
    resolver: zodResolver(OptionsForm),
    // Keyed by what kobai holds, so a save that landed leaves the rows showing the Product's
    // options rather than what was typed — including the identifiers kobai assigned to the ones
    // that were new a moment ago.
    values: { options: options.map((one) => ({ optionId: one.id, name: one.name })) },
  });
  // `optionId` rather than `id`, deliberately: `useFieldArray` writes a key of its own onto each
  // field object and that key is called `id`, so an option's real identifier under that name
  // would be the one thing this list cannot afford to lose.
  const rows = useFieldArray({ control: form.control, name: "options" });

  const save = useMutation({
    mutationFn: async (values: OptionsValues) =>
      orThrow(
        await client.PATCH("/admin/products/{id}", {
          params: { path: { id } },
          body: {
            options: values.options.map((one) =>
              // Left out entirely rather than sent as `undefined`, which is what tells kobai
              // this is a new option rather than one it should already know.
              one.optionId === undefined
                ? { name: one.name }
                : { id: one.optionId, name: one.name },
            ),
          },
        }),
      ),
    onSuccess: reread,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Options</h3>
        </CardTitle>
        <CardDescription>
          What a Shopper chooses this Product by, in the order a storefront should offer
          them — Size before Colour is your decision, not the storefront's. A Product sold
          as one thing needs none. Adding one leaves every Variant below without a value
          for it until you give it one.
        </CardDescription>
      </CardHeader>
      <form onSubmit={form.handleSubmit((values) => save.mutate(values))}>
        <CardContent className="grid gap-4">
          <Problem
            problem={save.isError ? whyNotChanged(save.error) : null}
            title="The options were not changed."
          />

          {rows.fields.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This Product declares no options, so it is sold as one thing and its
              Variants say nothing about size or colour.
            </p>
          ) : null}

          {rows.fields.map((row, index) => (
            <div key={row.id} className="grid items-end gap-2 sm:grid-cols-[1fr_auto]">
              <FormField
                id={`product-option-${row.id}`}
                label={`Option ${index + 1}`}
                error={form.formState.errors.options?.[index]?.name}
                {...form.register(`options.${index}.name`)}
              />
              <div className="flex gap-2">
                {/* Plain buttons rather than `ActionButton`s: these rearrange the form and
                    call kobai nothing, so there is no permission to explain — the one
                    control that writes is the submit below. `disabled` rather than
                    `aria-disabled` for the two that run out of list, on `Pager`'s reason:
                    there is no explanation to host on one.

                    Each says which row it is for in an `sr-only` span rather than in an
                    `aria-label`, because four buttons all announcing "Up" tell a screen
                    reader nothing about which — and a label that *replaced* the visible
                    word would leave the two names disagreeing, which is what a Merchant
                    driving this by voice would trip over. */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={index === 0}
                  onClick={() => rows.move(index, index - 1)}
                >
                  Up<span className="sr-only"> — option {index + 1}</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={index === rows.fields.length - 1}
                  onClick={() => rows.move(index, index + 1)}
                >
                  Down<span className="sr-only"> — option {index + 1}</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => rows.remove(index)}
                >
                  Remove<span className="sr-only"> — option {index + 1}</span>
                </Button>
              </div>
            </div>
          ))}

          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => rows.append({ name: "" })}
            >
              Add an option
            </Button>
          </div>
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton type="submit" unavailable={unavailable} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save options
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * The shape of a Product's option list, and only the shape (ADR-0063).
 *
 * `min(1)` on the name is the field being required. Whether two options may share a name, and
 * whether an identifier names an option of this Product, are kobai's rules and arrive as
 * refusals — restated here they would be a second, stale copy a Merchant could not appeal.
 */
const OptionsForm = z.object({
  options: z.array(
    z.object({
      optionId: z.string().optional(),
      name: z.string().min(1, "An option needs a name — Size, Colour."),
    }),
  ),
});

type OptionsValues = z.output<typeof OptionsForm>;

/**
 * The images this Product shows, and which of them leads.
 *
 * A card of its own beside Options rather than a section of the Product form, because it is the
 * same kind of thing Options is: a **list** kobai takes whole, where the order is a Merchant's
 * decision and the first entry is the one that leads (story 9). The list editing itself is
 * `components/media-attachments.tsx`, which each Variant card renders too.
 *
 * **Removing an image here detaches it and does not delete it** — the asset stays in the Media
 * section and may still be showing on another Product, and kobai deletes no Media and no bytes
 * at all (ADR-0082). That sentence is in the card because it is what a Merchant needs to know
 * before they will press Remove.
 */
function ProductMedia({
  id,
  media,
}: {
  readonly id: string;
  readonly media: readonly Media[];
}) {
  const client = useKobaiClient();
  const reread = useRereadProduct(id);
  const unavailable = useCannotWrite();

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Images</h3>
        </CardTitle>
        <CardDescription>
          What a storefront shows for this Product, in the order it should show them — the
          first one leads. Upload images in the Media section first, then attach them
          here. Removing one here detaches it: it stays in your Media and may still be
          showing on something else.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <MediaAttachments
          idPrefix="product-media"
          subject="this Product"
          attached={media}
          unavailable={unavailable}
          attach={async (attached) =>
            orThrow(
              await client.PATCH("/admin/products/{id}", {
                params: { path: { id } },
                body: { media: attached },
              }),
            )
          }
          onAttached={reread}
          problemOf={whyNotChanged}
        />
      </CardContent>
    </Card>
  );
}

/**
 * Which Collections this Product is in (#256, stories 13 and 14).
 *
 * A card of its own beside Images, and the same bargain: kobai takes `collections` as the whole
 * **set** of what this Product should now be in, so putting it into one and taking it out of one
 * are one field and one request. Where this parts company with Images is that a set has no
 * order — there is no first Collection and nothing to move up or down — which is why this is a
 * list of checkboxes rather than `useFieldArray` with Up and Down beside each row.
 *
 * **The picker itself is `components/collections-field.tsx`** since the New Product form began
 * offering the same question at a create (#280) — the second use, which is where a component
 * gets extracted here. What this card keeps is what is its own: the whole set kobai already
 * holds, the request that changes it, and the sentence below about what Remove does. The set of
 * Collections to choose from is read from kobai and never written down, through
 * `lib/collections.ts`, which the Products list's own filter reads from too — so the three ask
 * one question in one place and inherit the same known gap about the hundred-and-first
 * Collection.
 *
 * **Removing a Collection here takes this Product out of it and deletes nothing** — not the
 * Collection, and not the other Products in it. That sentence is in the card because a Merchant
 * who is unsure will not press it, and because the same word is true from the other end:
 * deleting a Collection leaves every Product it held alone (story 17).
 */
function ProductCollections({
  id,
  collections,
}: {
  readonly id: string;
  readonly collections: readonly Collection[];
}) {
  const client = useKobaiClient();
  const reread = useRereadProduct(id);
  const unavailable = useCannotWrite();

  const form = useForm<{ collections: string[] }>({
    // `values` rather than `defaultValues`, so a change that landed leaves the form showing what
    // kobai now holds rather than what was clicked at it.
    values: { collections: collections.map((one) => one.id) },
  });
  const save = useMutation({
    mutationFn: async (values: { collections: string[] }) =>
      orThrow(
        await client.PATCH("/admin/products/{id}", {
          params: { path: { id } },
          body: { collections: values.collections.map((one) => ({ id: one })) },
        }),
      ),
    onSuccess: reread,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Collections</h3>
        </CardTitle>
        <CardDescription>
          How a storefront groups this Product — it can be in as many as you like, or
          none. Unticking one takes this Product out of that Collection and deletes
          nothing: the Collection stays, and so does every other Product in it.
        </CardDescription>
      </CardHeader>
      <form onSubmit={form.handleSubmit((values) => save.mutate(values))}>
        <CardContent className="grid gap-6">
          <Problem
            problem={save.isError ? whyNotChanged(save.error) : null}
            title="The Collections were not changed."
          />
          <CollectionsField
            idPrefix="product-collection"
            control={form.control}
            name="collections"
            // The ones kobai did not offer and this Product is nevertheless in — the
            // hundred-and-first Collection, which a card that dropped it would take this
            // Product out of on the next save.
            alsoOffer={collections}
            whenNone={
              <p className="text-muted-foreground text-sm">
                This Store has no Collections yet. Make one in the Collections section and
                it will be offered here.
              </p>
            }
          />
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton type="submit" unavailable={unavailable} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save Collections
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * What a Variant's option fields start out holding — one entry per option the **Product**
 * declares, filled in from whatever that Variant already answers.
 *
 * Built from the Product's list rather than from the Variant's own values, which is what makes
 * an option declared since this Variant was written show up as an empty required field rather
 * than not at all. That is the repair kobai points at, rendered. A Variant being *created*
 * answers nothing yet and passes `[]`, which is the same walk with every value empty.
 */
function optionValuesFor(
  options: readonly ProductOption[],
  answered: readonly VariantOptionValue[],
): { name: string; value: string }[] {
  return options.map((one) => ({
    name: one.name,
    value: answered.find((held) => held.name === one.name)?.value ?? "",
  }));
}

/**
 * The fields a Variant answers its Product's options with — one text box per declared option.
 *
 * One component because there are two Variant forms on this screen and they render this
 * identically: correcting a Variant, and adding one. `listbox-field.tsx`'s lesson is the reason
 * it is a component on the second rather than on the third — the third is what gets to
 * reintroduce every defect the first two had fixed by hand (#245).
 *
 * **It takes the registration and the error for a row rather than the form**, which is
 * `components/form-field.tsx`'s bargain one level up: the two forms here have different
 * react-hook-form generics — and a zod `transform` makes a third shape wherever one appears — so
 * a component holding the form object would have to be generic over all of it to render two text
 * boxes. `errorFor` is a lookup rather than the array for the same reason: what
 * `formState.errors` holds for an array field is react-hook-form's own merged type, and naming
 * it here would be this component knowing the library rather than the field.
 *
 * The `id` prefix is the caller's because an `id` is unique to the **document** rather than to
 * the form it is in, and two Variant cards would otherwise point both labels at whichever input
 * rendered last.
 */
function VariantOptionFields({
  idPrefix,
  options,
  register,
  errorFor,
}: {
  readonly idPrefix: string;
  readonly options: readonly ProductOption[];
  readonly register: (name: `options.${number}.value`) => object;
  readonly errorFor: (index: number) => { readonly message?: string } | undefined;
}) {
  return options.map((option, index) => (
    <FormField
      key={option.id}
      id={`${idPrefix}-${option.id}`}
      label={option.name}
      error={errorFor(index)}
      {...register(`options.${index}.value`)}
    />
  ));
}

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
  options,
  status,
}: {
  readonly productId: string;
  readonly variant: Variant;
  /** The **Product's** declared options, which is what this Variant has to answer. */
  readonly options: readonly ProductOption[];
  /**
   * The **Product's** status, which the price preview needs and nothing else here does.
   *
   * Passed down rather than read again: whether a storefront can ask about this Variant at all
   * is a fact about the Product this card belongs to, and the screen is already holding it
   * (#276).
   */
  readonly status: ProductStatus;
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
        <VariantIdentity productId={productId} variant={variant} options={options} />

        <Separator />

        <VariantMedia productId={productId} variant={variant} />

        <Separator />

        <Prices productId={productId} variant={variant} />

        <Separator />

        <Stock productId={productId} variant={variant} />

        <Separator />

        <StorefrontPrice
          variantId={variant.id}
          status={status}
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
  options,
}: {
  readonly productId: string;
  readonly variant: Variant;
  readonly options: readonly ProductOption[];
}) {
  const client = useKobaiClient();
  const reread = useRereadProduct(productId);
  const unavailable = useCannotWrite();

  const form = useForm({
    resolver: zodResolver(IdentityForm),
    // `values` rather than `defaultValues`, so a correction that landed leaves every field
    // showing what kobai now holds rather than what was typed at it — and so that an option
    // declared on the Product a moment ago appears here as a field to fill in.
    values: {
      sku: variant.sku,
      strategy: variant.fulfilment.strategy,
      options: optionValuesFor(options, variant.options),
    },
  });

  const correct = useMutation({
    mutationFn: async (values: IdentityValues) =>
      orThrow(
        await client.PATCH("/admin/variants/{id}", {
          params: { path: { id: variant.id } },
          body: {
            sku: values.sku,
            fulfilment: { strategy: values.strategy },
            // Always sent, because kobai **replaces** what is stored with what is named —
            // exactly as it does for `metadata` — so a form that sent some of them would take
            // the rest away. For a Product declaring no options this is `[]`, which is what
            // such a Variant already holds.
            options: values.options,
          },
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
            control={form.control}
            name="strategy"
            description="How this Variant is delivered. Swapping it is how a poster becomes a download; whatever stock has been counted stays counted (ADR-0062)."
          />
          <VariantOptionFields
            idPrefix={`variant-option-${variant.id}`}
            options={options}
            register={form.register}
            errorFor={(index) => form.formState.errors.options?.[index]?.value}
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
  /**
   * One entry per option the **Product** declares, which is what kobai requires of a Variant:
   * every declared option answered, and no option that is not declared. `min(1)` is the field
   * being required — an option added on the Product since this Variant was written arrives here
   * empty, and this is what says so before the round trip that would refuse it.
   */
  options: z.array(
    z.object({
      name: z.string(),
      value: z.string().min(1, "This Variant needs a value for every option."),
    }),
  ),
});

type IdentityValues = z.output<typeof IdentityForm>;

/**
 * The images this **Variant** shows — the picture a storefront swaps to when a Shopper picks
 * this size or colour (story 10).
 *
 * A section of the Variant card rather than a card of its own, beside Prices and Stock, because
 * it is one more thing this Variant says about itself. It is deliberately **not** part of the
 * Variant's identity form above: attaching a picture and correcting a SKU are two errands, and
 * one Save that always sent both would make a Merchant fixing a typo also re-send whatever the
 * picker happened to be showing.
 *
 * **This list does not extend its Product's and is not extended by it.** kobai reports the two
 * separately on purpose, so what a storefront does when a Variant has its own is the
 * storefront's decision — which is exactly why this section says nothing about what happens
 * when it is empty.
 */
function VariantMedia({
  productId,
  variant,
}: {
  readonly productId: string;
  readonly variant: Variant;
}) {
  const client = useKobaiClient();
  const reread = useRereadProduct(productId);
  const unavailable = useCannotWrite();

  return (
    <div className="grid gap-4">
      <div>
        <h4 className="font-medium text-sm">Images</h4>
        <p className="text-muted-foreground text-sm">
          Shown when a Shopper picks this Variant. These are this Variant's own — the
          Product's images are set on the card above, and a storefront is given both.
        </p>
      </div>
      <MediaAttachments
        idPrefix={`variant-media-${variant.id}`}
        subject="this Variant"
        attached={variant.media}
        unavailable={unavailable}
        attach={async (attached) =>
          orThrow(
            await client.PATCH("/admin/variants/{id}", {
              params: { path: { id: variant.id } },
              body: { media: attached },
            }),
          )
        }
        onAttached={reread}
        problemOf={whyNotChanged}
      />
    </div>
  );
}

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
  const currencies = useEnabledCurrencies();
  const regions = useOfferedRegions();
  const channels = useOfferedChannels();

  const form = useForm<PriceInput, unknown, PriceValues>({
    resolver: zodResolver(PriceForm),
    defaultValues: {
      amount: "",
      currency: THE_STORES_DEFAULT,
      regionId: EVERYWHERE,
      channelId: EVERYWHERE,
    },
  });

  // **The currency follows the Region as a suggestion, never as a rule.** A Price denominated in
  // something the chosen Region does not select is a row kobai accepts and `select-price` can
  // never pick, because a Region decides the currency and kobai converts nothing — so the field
  // starts on the right answer rather than the form refusing the wrong one, which would be the
  // Admin holding a rule that lives in Core (ADR-0063).
  const chosenRegion = form.watch("regionId");
  const suggested =
    regions.offered.find((one) => one.id === chosenRegion)?.currency ?? null;
  useEffect(() => {
    // Only when a Region was chosen, and the Merchant can still put it back: *this Store's
    // default* is an option in the list rather than a placeholder, so following the Region is a
    // suggestion they can decline rather than a door that closes behind them.
    if (suggested !== null) form.setValue("currency", suggested);
  }, [suggested, form]);

  const add = useMutation({
    mutationFn: async (values: PriceValues) =>
      orThrow(
        await client.POST("/admin/variants/{id}/prices", {
          params: { path: { id: variant.id } },
          body: {
            amount: values.amount,
            // Left out rather than sent empty, because *the Store's default* is what leaving
            // it out means — the same bargain the two constraints below take, one field along.
            ...(values.currency === THE_STORES_DEFAULT
              ? {}
              : { currency: values.currency }),
            ...constrainedTo(values.regionId, values.channelId),
          },
        }),
      ),
    onSuccess: () =>
      form.reset({
        amount: "",
        currency: THE_STORES_DEFAULT,
        regionId: EVERYWHERE,
        channelId: EVERYWHERE,
      }),
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
              <TableHead>Region</TableHead>
              <TableHead>Channel</TableHead>
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
                {/* **Every Region rather than a blank**, because `null` here means the Price
                    applies to all of them — and a Merchant reading an empty cell would take it
                    for a Price that applies to none. */}
                <TableCell>{price.region?.name ?? "Every Region"}</TableCell>
                <TableCell>{price.channel?.name ?? "Every Channel"}</TableCell>
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
          {/* **Three pickers over three sets kobai names**, and none of them a constant here
              (ADR-0063): the currencies this Store has enabled, and the Regions and Channels a
              Merchant made next door. Every one of them is a deployment's decision, so a list
              written into this file would be wrong on the first Store that made another. */}
          <div className="grid gap-4 sm:col-span-2 sm:grid-cols-3">
            {/* **The currency picker is the Region screen's**, over the same enabled set and
                named the same way (#300), because a Merchant choosing a currency here is being
                asked the question they are asked two screens away — filterable with it, and
                strictly closed with it, since a Price is denominated in something the Store has
                enabled. **The Region and Channel pickers beside it are deliberately not**: their
                vocabulary is rows a Merchant made, a Store has a handful of each, and neither
                changed here. */}
            <ComboboxField
              id={`variant-new-price-currency-${variant.id}`}
              control={form.control}
              name="currency"
              label="Currency"
              // The Store's default heads the list and is **not** a currency: it is how a
              // Merchant says "whatever this Store prices in", which is why it keeps its own
              // words rather than being named after a code. Typing narrows to the codes, as it
              // should — somebody typing `MYR` is not reaching for the default — and it is there
              // again the moment the box is empty.
              options={[
                { value: THE_STORES_DEFAULT, label: "This Store's default" },
                ...currencies.options,
              ]}
              empty="Nothing matches that. A Price is denominated in a currency this Store has enabled — the Store screen is where another is."
              // **A failed read says which one it was** (#311). This field was already dead when
              // `GET /admin/store` failed — that is what `answered` being `false` for ever meant
              // — but it said nothing, so it read as a picker that had simply not loaded. It now
              // reports the failure the way the two pickers beside it do, off the same `error`.
              description={
                whyCurrenciesNotRead(currencies) ??
                (suggested === null
                  ? "Any currency this Store has enabled. Left as it is, kobai uses the Store's default."
                  : `${suggested} is what that Region prices in. A Price in another currency is stored and never applies there.`)
              }
              disabled={currencies.error !== null}
            />
            <ListboxField
              id={`variant-new-price-region-${variant.id}`}
              control={form.control}
              name="regionId"
              label="Region"
              options={[
                { value: EVERYWHERE, label: "Every Region" },
                ...regions.offered.map((one) => ({
                  value: one.id,
                  label: `${one.name} (${one.currency})`,
                })),
              ]}
              description={
                whyRegionsNotRead(regions) ??
                "Where this Price applies. Every Region is the fallback a Region-specific Price beats."
              }
              disabled={regions.error !== null}
            />
            <ListboxField
              id={`variant-new-price-channel-${variant.id}`}
              control={form.control}
              name="channelId"
              label="Channel"
              options={[
                { value: EVERYWHERE, label: "Every Channel" },
                ...channels.offered.map((one) => ({ value: one.id, label: one.name })),
              ]}
              description={
                whyChannelsNotRead(channels) ??
                "Which route to market this Price applies through. A storefront is in the Channel its API key was minted into."
              }
              disabled={channels.error !== null}
            />
          </div>
        </div>
      </form>
    </fieldset>
  );
}

/**
 * What the two constraint pickers hold for *unconstrained*.
 *
 * A sentinel rather than `""`, because `""` is what `ListboxField` reads as **nothing chosen**
 * and this is a choice a Merchant makes: *every Region* is the commonest Price there is, and a
 * picker that showed a placeholder for it would read as a field nobody had filled in.
 */
const EVERYWHERE = "everywhere";

/**
 * What the currency picker holds for *whatever this Store prices in*.
 *
 * {@link EVERYWHERE}'s argument one field along, and it earns its keep for a second reason: the
 * field follows the chosen Region, so without an option meaning the default a Merchant who
 * picked a Region once could never get back to leaving the currency out.
 */
const THE_STORES_DEFAULT = "the-store's-default";

/** The two constraints as `POST /admin/variants/{id}/prices` takes them: named, or left out. */
function constrainedTo(
  regionId: string,
  channelId: string,
): { regionId?: string; channelId?: string } {
  return {
    ...(regionId === EVERYWHERE ? {} : { regionId }),
    ...(channelId === EVERYWHERE ? {} : { channelId }),
  };
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
          // **The new Price applies where the old one did**, which is the whole of what
          // superseding means: a Merchant correcting what Malaysia pays must not be handed a
          // Price for everywhere. There is no picker here for the same reason there is no
          // amount picker — this control replaces one row with another, and changing what a
          // Price applies to is adding a different Price and removing this one.
          body: {
            amount,
            currency: price.currency,
            ...(price.region === null ? {} : { regionId: price.region.id }),
            ...(price.channel === null ? {} : { channelId: price.channel.id }),
          },
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
 * A whole Price as the Add form holds it: the amount, and the three things it applies to.
 *
 * **Structure only, like every schema in this Admin** (ADR-0063). Whether this Store has enabled
 * that currency, and whether it has that Region, are facts about the Store that arrive as
 * refusals — the pickers offer what kobai answered, and a Region deleted since the list was read
 * is a `region-not-found` this form can really meet.
 */
const PriceForm = AmountForm.extend({
  currency: z.string(),
  regionId: z.string(),
  channelId: z.string(),
});

type PriceInput = z.input<typeof PriceForm>;
type PriceValues = z.output<typeof PriceForm>;

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
function NewVariant({
  productId,
  options,
}: {
  readonly productId: string;
  readonly options: readonly ProductOption[];
}) {
  const client = useKobaiClient();
  const reread = useRereadProduct(productId);
  const unavailable = useCannotWrite();

  const form = useForm({
    resolver: zodResolver(IdentityForm),
    // `values` rather than `defaultValues`, so declaring an option on the Product puts a field
    // for it here too — a new Variant has to answer every one of them or kobai refuses it.
    values: {
      sku: "",
      strategy: DEFAULT_STRATEGY,
      options: optionValuesFor(options, []),
    },
  });

  const add = useMutation({
    mutationFn: async (values: IdentityValues) =>
      orThrow(
        await client.POST("/admin/products/{id}/variants", {
          params: { path: { id: productId } },
          body: {
            sku: values.sku,
            fulfilment: { strategy: values.strategy },
            options: values.options,
          },
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
            control={form.control}
            name="strategy"
          />
          <VariantOptionFields
            idPrefix="new-variant-option"
            options={options}
            register={form.register}
            errorFor={(index) => form.formState.errors.options?.[index]?.value}
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
    case "handle-taken":
    case "last-variant":
    case "stock-is-reserved":
    case "unsupported-currency":
    case "unknown-fulfilment-strategy":
    case "variant-options-mismatch":
    case "variant-combination-taken":
    case "media-not-found":
    case "collection-not-found":
    case "region-not-found":
    case "channel-not-found":
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
 * `CatalogRefusal` is the busiest closed family the Admin touches — eleven reasons — and this is
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
    case "handle-taken":
    case "unsupported-currency":
    case "unknown-fulfilment-strategy":
    case "variant-options-mismatch":
    case "variant-combination-taken":
    case "media-not-found":
    case "collection-not-found":
    case "region-not-found":
    case "channel-not-found":
      // Not reachable from a delete, which sends no body and names no SKU, handle, currency,
      // Strategy, option value, combination, image, Collection, Region or Channel. Reported as
      // kobai said it rather than as a sentence written for a case nobody has seen.
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

    case "handle-taken":
      return "Another Product is already reached at that handle. A handle is the address a storefront links to, so it cannot name two — give this one its own.";

    case "unknown-fulfilment-strategy":
      // kobai's prose lists the ones it *does* have, which is exactly what is wanted here and
      // is a set this browser could be holding a stale copy of.
      return problemOf(thrown, fallback);

    case "variant-options-mismatch":
      // The one refusal on this screen a Merchant reaches by doing two things in the right
      // order and the second one late: an option was declared on the Product, and this Variant
      // is being saved without a value for it — or with a value for one that has since gone.
      // kobai's prose names the options, which this form knows and the message may as well not
      // repeat; what it adds is where the answer is given.
      return "This Variant must say what it is for every option this Product declares, and for no other. Its Product's options may have changed since this page was opened — reload it, then fill in the value for each.";

    case "variant-combination-taken":
      // Reached two ways from this screen, and kobai's prose is better than anything written
      // here for either: saving a Variant onto the combination another already answers, and
      // removing an option two Variants were told apart by. Both refusals **name the Variants
      // by SKU** — which is the whole of what a Merchant needs in order to go and repair one,
      // and is exactly what this form does not know.
      return problemOf(thrown, fallback);

    case "media-not-found":
      // The one refusal here a Merchant reaches by having *two* pages open: an image was
      // deleted from the library after this screen read it. There is no route that deletes a
      // Media today (ADR-0082), so this is unreachable through the Admin as it stands — and it
      // is worded rather than deferred to kobai's prose because when that route arrives this is
      // exactly what a Merchant will meet, and the sentence is the same either way.
      return "One of the images chosen is no longer in this Store's Media. Reload this page and pick from the Media it then shows.";

    case "collection-not-found":
      // Its twin, and this one is reachable today: a colleague deleted a Collection between
      // this card reading the list and the Merchant saving it. The Product is untouched and the
      // repair is to see the list again — which is why the sentence says reload rather than
      // apologising.
      return "One of the Collections ticked is no longer there — somebody deleted it while this page was open. Reload this page and tick from the Collections it then shows.";

    case "product-not-found":
    case "variant-not-found":
      return "It is no longer there — somebody else deleted it, or this page has been open a while.";

    case "unsupported-currency":
      // Widened by #292 and still one sentence: a Price is denominated in one of the currencies
      // the Store has **enabled**, and the repair is on the Store screen rather than on this
      // form. kobai converts nothing, so there is no second thing this could mean.
      return "This Store has not enabled that currency. Enable it on the Store screen, or price this Variant in one it already has.";

    case "region-not-found":
    case "channel-not-found":
      // Reachable the way `collection-not-found` is: a Region or a Channel that was in the
      // picker when it was read has been deleted since. Nothing was written — kobai judges both
      // before it inserts anything — so the repair is to see the lists again.
      return "The Region or Channel this Price applies to is no longer there — somebody deleted it while this page was open. Nothing was added: reload this page and choose from what it then shows.";

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
