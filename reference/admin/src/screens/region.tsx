import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GlobeIcon } from "lucide-react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { z } from "zod";
import { ActionButton } from "@/components/action-button";
import { ComboboxField } from "@/components/combobox-field";
import { ConfirmDelete } from "@/components/confirm-delete";
import { FormField } from "@/components/form-field";
import { LinkButton } from "@/components/link-button";
import { Problem } from "@/components/problem";
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
import { PERMISSIONS, useUnavailable } from "@/lib/permissions";
import { orThrow, problemOf, regionReasonOf } from "@/lib/refusal";
import { useRouteId } from "@/lib/route";
import { useKobaiClient } from "@/lib/session";
import { useEnabledCurrencies } from "@/lib/store";

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
    </div>
  );
}

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
              prices in a dozen places has a list worth narrowing. */}
          <ComboboxField
            control={form.control}
            name="currency"
            id="region-currency"
            label="Currency"
            options={currencies.options}
            empty="This Store does not price in that. The Store screen is where a currency is enabled."
            description="One of the currencies this Store may price in — the Store screen is where another is enabled. Moving a Region onto another currency changes which Prices apply here; it converts nothing."
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
