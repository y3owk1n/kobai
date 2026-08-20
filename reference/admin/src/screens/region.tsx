import { zodResolver } from "@hookform/resolvers/zod";
import type { ShippingOption } from "@kobai/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GlobeIcon } from "lucide-react";
import { useFieldArray, useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { z } from "zod";
import { ActionButton } from "@/components/action-button";
import { ComboboxField } from "@/components/combobox-field";
import { ConfirmDelete } from "@/components/confirm-delete";
import { FormField } from "@/components/form-field";
import { LinkButton } from "@/components/link-button";
import { Problem } from "@/components/problem";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useCrumbTitle } from "@/lib/crumb";
import { currencyLabel } from "@/lib/currencies";
import { PERMISSIONS, useUnavailable } from "@/lib/permissions";
import { orThrow, problemOf, regionReasonOf } from "@/lib/refusal";
import { useRouteId } from "@/lib/route";
import { useKobaiClient } from "@/lib/session";
import { useEnabledCurrencies, whyCurrenciesNotRead } from "@/lib/store";

/**
 * One Region: what it is called, what it prices in, and the way to remove it (#291, ADR-0074).
 *
 * **A Region's currency moves and the Store's does not**, and this screen is where that
 * asymmetry is visible: the Store screen shows its default currency read-only with the reason
 * beside it, and this one offers a picker. The difference is not a preference — the Store's
 * default denominates every Price carrying no Region and no Channel, so moving it would
 * reinterpret those amounts (ADR-0065), while a Region *selects* one of the enabled set and
 * moving the selection changes which Prices apply here rather than what any of them means.
 *
 * `metadata` is deliberately never sent. `PATCH /admin/regions/{id}` **replaces** it rather than
 * merging (ADR-0062), so a form submitting an empty object would silently discard whatever a
 * Project stashed there — and leaving the field out is what "leave it alone" means.
 */
const REGION = "region";

export function RegionScreen() {
  const client = useKobaiClient();
  const id = useRouteId();

  const region = useQuery({
    queryKey: [REGION, id],
    queryFn: async () =>
      orThrow(await client.GET("/admin/regions/{id}", { params: { path: { id } } })),
  });

  // The breadcrumb otherwise reads as the identifier out of the URL, which is the one thing on
  // this screen a Merchant cannot use to tell one Region from another.
  useCrumbTitle(region.data?.name);

  if (region.isPending) return <RegionLoading />;

  if (region.isError) {
    return regionReasonOf(region.error) === "region-not-found" ? (
      <NoSuchRegion />
    ) : (
      <Problem
        title="That Region could not be read."
        problem={problemOf(region.error, "kobai did not answer.")}
      />
    );
  }

  const found = region.data;

  return (
    <div className="grid gap-6">
      {/* An `h2`: the frame renders the page's `h1` from the route, so this is the heading
          under it rather than a second first-level one. */}
      <h2 className="font-medium text-xl">{found.name}</h2>

      <RegionIdentity id={id} name={found.name} currency={found.currency} />

      <ShippingMethods
        id={id}
        currency={found.currency}
        methods={found.shippingMethods}
      />
    </div>
  );
}

/**
 * How this Store delivers into this Region, and what each way costs (#321).
 *
 * **One form over the whole list, because kobai takes the whole list.**
 * `PATCH /admin/regions/{id}` reads `shippingMethods` as what the Region's rates should now
 * *be* — an entry carrying an `id` is the method that already has it, one without is new, and
 * one this Region has that the list does not name is removed. So adding, renaming, repricing,
 * reordering and removing are the same request, exactly as the Product screen's Options card
 * is, and this is a list a Merchant edits rather than four controls.
 *
 * **Removing one is not the same as deleting a Product**, so there is no `ConfirmDelete` here:
 * kobai refuses nothing for it, and a Cart that had chosen the rate is left choosing again
 * rather than broken. The row a Merchant is about to lose is in front of them and Save is what
 * commits it, which is the bargain the Options card already takes.
 *
 * **A rate is in this Region's currency and carries no code of its own**, which is why the
 * amount field says which one: a Region selects exactly one currency and kobai converts
 * nothing (ADR-0074), so moving this Region onto another currency reinterprets these figures
 * rather than converting them.
 */
function ShippingMethods({
  id,
  currency,
  methods,
}: {
  readonly id: string;
  readonly currency: string;
  readonly methods: readonly ShippingOption[];
}) {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const unavailable = useUnavailable(PERMISSIONS.storeWrite, "change the Store");

  const form = useForm<ShippingMethodsInput, unknown, ShippingMethodsValues>({
    resolver: zodResolver(ShippingMethodsForm),
    // Keyed by what kobai holds, so a save that landed leaves the rows showing the Region's
    // rates rather than what was typed — including the identifiers kobai assigned to the ones
    // that were new a moment ago.
    values: {
      shippingMethods: methods.map((one) => ({
        methodId: one.id,
        name: one.name,
        amount: String(one.amount),
      })),
    },
  });
  // `methodId` rather than `id`, for the Options card's reason: `useFieldArray` writes a key of
  // its own onto each field object and that key is called `id`, so a method's real identifier
  // under that name would be the one thing this list cannot afford to lose — losing it turns
  // every rename into a removal and an addition, and takes every Cart that chose it off.
  const rows = useFieldArray({ control: form.control, name: "shippingMethods" });

  const save = useMutation({
    mutationFn: async (values: ShippingMethodsValues) =>
      orThrow(
        await client.PATCH("/admin/regions/{id}", {
          params: { path: { id } },
          body: {
            shippingMethods: values.shippingMethods.map((one) =>
              // Left out entirely rather than sent as `undefined`, which is what tells kobai
              // this is a new method rather than one it should already know.
              one.methodId === undefined
                ? { name: one.name, amount: one.amount }
                : { id: one.methodId, name: one.name, amount: one.amount },
            ),
          },
        }),
      ),
    onSuccess: () => void queries.invalidateQueries({ queryKey: [REGION, id] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Shipping methods</h3>
        </CardTitle>
        <CardDescription>
          How this Store delivers into this Region, in the order a storefront should offer
          them. Each rate is a flat charge in {currencyLabel(currency)}, and it lands on
          the Order as its own line rather than being folded into what the goods cost. A
          Region with none prices no delivery: a Cart there is offered nothing and charged
          nothing to be delivered.
        </CardDescription>
      </CardHeader>
      <form onSubmit={form.handleSubmit((values) => save.mutate(values))}>
        <CardContent className="grid gap-4">
          <Problem
            problem={save.isError ? whyNotChanged(save.error) : null}
            title="The shipping methods were not changed."
          />

          {rows.fields.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This Store prices no delivery into this Region, so nothing in a Cart bought
              here is charged carriage.
            </p>
          ) : null}

          {rows.fields.map((row, index) => (
            <div
              key={row.id}
              className="grid items-end gap-2 sm:grid-cols-[1fr_10rem_auto]"
            >
              <FormField
                id={`shipping-method-name-${row.id}`}
                label={`Method ${index + 1}`}
                error={form.formState.errors.shippingMethods?.[index]?.name}
                {...form.register(`shippingMethods.${index}.name`)}
              />
              <FormField
                id={`shipping-method-amount-${row.id}`}
                label="Rate, in minor units"
                error={form.formState.errors.shippingMethods?.[index]?.amount}
                {...form.register(`shippingMethods.${index}.amount`)}
              />
              {/* Plain buttons rather than `ActionButton`s: these rearrange the form and
                  call kobai nothing, so there is no permission to explain — the one control
                  that writes is the submit below. Each says which row it is for in an
                  `sr-only` span, because three buttons all announcing "Up" tell a screen
                  reader nothing about which. */}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={index === 0}
                  onClick={() => rows.move(index, index - 1)}
                >
                  Up<span className="sr-only"> — method {index + 1}</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={index === rows.fields.length - 1}
                  onClick={() => rows.move(index, index + 1)}
                >
                  Down<span className="sr-only"> — method {index + 1}</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => rows.remove(index)}
                >
                  Remove<span className="sr-only"> — method {index + 1}</span>
                </Button>
              </div>
            </div>
          ))}

          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => rows.append({ name: "", amount: "" })}
            >
              Add a shipping method
            </Button>
          </div>
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton type="submit" unavailable={unavailable} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save shipping methods
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * The shape of a Region's shipping methods, and only the shape (ADR-0063).
 *
 * The amount is **parsed rather than coerced from a blank**, exactly as the Price editor's is:
 * an `<input>` hands over a string, so an empty one has to be caught before `Number("")` turns
 * it into free delivery nobody chose. Whether kobai will take the number — negative, absurd —
 * and whether an identifier names a method of this Region are Core's answers and arrive as
 * refusals; restated here they would be a second, stale copy a Merchant could not appeal.
 */
const ShippingMethodsForm = z.object({
  shippingMethods: z.array(
    z.object({
      methodId: z.string().optional(),
      name: z.string().min(1, "A method needs a name — Standard, Next day."),
      amount: z
        .string()
        .min(1, "A rate is a whole number of minor units — 500 is 5.00.")
        .transform((typed) => Number(typed))
        .pipe(
          z
            .number("A rate is a whole number of minor units — 500 is 5.00.")
            .int("Minor units are whole: 500, not 5.00."),
        ),
    }),
  ),
});

type ShippingMethodsInput = z.input<typeof ShippingMethodsForm>;
type ShippingMethodsValues = z.output<typeof ShippingMethodsForm>;

/**
 * The shape of the form, and only the shape (ADR-0063).
 *
 * Whether the currency is one this Store has enabled is kobai's rule and is not predicted here —
 * a colleague may enable another in the tab next door, and a browser that decided would be
 * wrong about a Store it does not own.
 */
const RegionForm = z.object({
  name: z.string().min(1, "A Region is named — the place, as you would say it."),
  currency: z.string().min(1, "A Region prices in one of this Store's currencies."),
});

type RegionValues = z.infer<typeof RegionForm>;

/** What the Region is called, what it prices in, and the way to delete it. */
function RegionIdentity({
  id,
  name,
  currency,
}: {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
}) {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const navigate = useNavigate();
  const unavailable = useUnavailable(PERMISSIONS.storeWrite, "change the Store");
  const currencies = useEnabledCurrencies();

  const form = useForm<RegionValues>({
    resolver: zodResolver(RegionForm),
    // `values` rather than `defaultValues`, so a change that landed leaves the form showing
    // what kobai now holds rather than what was typed at it.
    values: { name, currency },
  });

  const save = useMutation({
    mutationFn: async (values: RegionValues) =>
      orThrow(
        await client.PATCH("/admin/regions/{id}", {
          params: { path: { id } },
          body: { name: values.name, currency: values.currency },
        }),
      ),
    // Re-read rather than patched in place, like every write in this Admin (ADR-0063).
    onSuccess: () => void queries.invalidateQueries({ queryKey: [REGION, id] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Region</CardTitle>
        <CardDescription>
          Where this Store sells, and what that place pays in. kobai converts nothing — a
          Variant with no Price in this currency has no price here.
        </CardDescription>
        <CardAction>
          <ConfirmDelete
            trigger="Delete Region"
            title="Delete this Region?"
            // The sentence a Merchant most needs before pressing this: the one thing that can
            // refuse it, and what to do about it (ADR-0059).
            description="A storefront that asks for a price without naming a Region is answered for this Store's default one — so if this is that Region, kobai will turn the deletion back and the Store screen is where another is chosen."
            unavailable={unavailable}
            onDelete={async () =>
              orThrow(
                await client.DELETE("/admin/regions/{id}", { params: { path: { id } } }),
              )
            }
            // Away from an address that no longer resolves. The list behind it re-reads on
            // arrival — nothing in this cache is ever fresh — so there is no key to invalidate.
            onDeleted={() => void navigate("/regions", { replace: true })}
            problemOf={whyNotDeleted}
          />
        </CardAction>
      </CardHeader>
      <form onSubmit={form.handleSubmit((values) => save.mutate(values))}>
        <CardContent className="grid gap-6">
          <Problem
            problem={save.isError ? whyNotChanged(save.error) : null}
            title="The Region was not changed."
          />
          <FormField
            id="region-name"
            label="Name"
            error={form.formState.errors.name}
            {...form.register("name")}
          />
          {/* The set is the Store's enabled currencies, read from `GET /admin/store` — a
              deployment's decision, so it is asked about rather than written down (ADR-0063).
              Filterable for the reason the Store screen's picker is (#300): the control a
              Merchant types a code into is the same control on both screens, and a Store that
              prices in a dozen places has a list worth narrowing.

              **A read that failed says so** (#311): an empty list is what a Store that prices in
              nothing looks like, so a picker that drew one either way would send a Merchant to
              the Store screen to enable a currency that is very likely already there. It is the
              Region and Channel pickers' shape on the Product screen, one noun along. */}
          <ComboboxField
            control={form.control}
            name="currency"
            id="region-currency"
            label="Currency"
            options={currencies.options}
            empty="This Store does not price in that. The Store screen is where a currency is enabled."
            description={
              whyCurrenciesNotRead(currencies) ??
              "One of the currencies this Store may price in — the Store screen is where another is enabled. Moving a Region onto another currency changes which Prices apply here; it converts nothing."
            }
            disabled={currencies.error !== null}
          />
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton type="submit" unavailable={unavailable} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save Region
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/** The Region, before it is there. */
function RegionLoading() {
  return (
    <div className="grid gap-6" role="status" aria-label="Reading the Region">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/**
 * An address naming a Region this Store does not have.
 *
 * Its own screen rather than a red box, because it is the one refusal here a Merchant can act on
 * and the action is "go back to the list" — a Region somebody deleted, or a link kept too long.
 */
function NoSuchRegion() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <GlobeIcon />
        </EmptyMedia>
        <EmptyTitle>No such Region</EmptyTitle>
        <EmptyDescription>
          This Store has no Region at that address. It may have been deleted since the
          link was made.
        </EmptyDescription>
      </EmptyHeader>
      <LinkButton to="/regions">Go to Regions</LinkButton>
    </Empty>
  );
}

/** Why kobai refused a **change** to this Region. */
function whyNotChanged(thrown: unknown): string {
  const fallback = "kobai would not make that change.";
  const reason = regionReasonOf(thrown);

  switch (reason) {
    case "region-not-found":
      return "It is no longer there — somebody else deleted this Region, or this page has been open a while.";

    case "currency-not-enabled":
      return "This Store does not price in that currency. Enable it on the Store screen first — a Region may only select a currency the Store has.";

    case "shipping-method-not-found":
      // Reachable from the shipping card and not from the identity form, and the two share this
      // function because they share the family — a rate somebody else deleted while this page
      // was open, which is the one thing a Merchant can act on here.
      return "One of these shipping methods is no longer there — somebody else removed it, or this page has been open a while. Reload and set the rates again.";

    case "invalid":
    case "malformed-body":
      // kobai's own prose names the field, which is more than this screen knows.
      return problemOf(thrown, fallback);

    case "region-in-use":
      // A refusal of the deletion, not reachable from a change.
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
 * Why kobai refused the **deletion**, rendered inside the dialog it was attempted from
 * (ADR-0059).
 *
 * The delete control is still offered and the attempt is still made — nothing here predicts an
 * answer, which is `ConfirmDelete`'s whole bargain, and whether this Region is the Store's
 * default is a fact kobai holds rather than one this screen reads.
 */
function whyNotDeleted(thrown: unknown): string {
  const fallback = "The Region was not deleted.";
  const reason = regionReasonOf(thrown);

  switch (reason) {
    case "region-in-use":
      return "This is the Region a storefront is answered for when it names none, so kobai will not leave the Store without one. Choose another default on the Store screen, then delete this one.";

    case "region-not-found":
      return "It is already gone — somebody else deleted it, or this page has been open a while.";

    case "currency-not-enabled":
    case "shipping-method-not-found":
    case "invalid":
    case "malformed-body":
      // Not reachable from a delete, which sends no body. Reported as kobai said it rather than
      // as a sentence written here for a case nobody has seen.
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
