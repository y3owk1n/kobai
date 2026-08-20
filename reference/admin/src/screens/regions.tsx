import { zodResolver } from "@hookform/resolvers/zod";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { GlobeIcon } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ActionButton } from "@/components/action-button";
import { ComboboxField } from "@/components/combobox-field";
import { FormField } from "@/components/form-field";
import { LinkButton } from "@/components/link-button";
import { Pager, usePageCursor } from "@/components/pager";
import { Problem } from "@/components/problem";
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
import { PERMISSIONS, useUnavailable } from "@/lib/permissions";
import { orThrow, problemOf, regionReasonOf } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";
import { useEnabledCurrencies, whyCurrenciesNotRead } from "@/lib/store";

/**
 * The geographies this Store sells into, and the way to define another (#291, ADR-0074).
 *
 * **A Region selects a currency rather than declaring one**, which is the whole of why the
 * picker below reads `GET /admin/store` instead of holding a list of the world's currencies: the
 * Store enumerates what may be priced in, and this Admin may hold what kobai's *types* close and
 * must ask about what a deployment decides. A currency this Store has not enabled is refused by
 * kobai, and offering it here would be an affordance that was always going to be turned back.
 *
 * It pages through the cursor like every other list here (ADR-0064), for ADR-0067's reason
 * rather than because a Store will have hundreds: a Merchant can create one over HTTP while a
 * colleague is reading the list.
 *
 * Which Region a storefront that names none is answered for is the **Store**'s field, not a flag
 * on a row here — one deployment has one default and the Store screen is where it is set.
 */
const REGIONS = "regions";

export function Regions() {
  const client = useKobaiClient();
  const after = usePageCursor();

  const page = useQuery({
    queryKey: [REGIONS, after ?? null],
    queryFn: async () =>
      orThrow(
        await client.GET("/admin/regions", {
          params: { query: after === undefined ? {} : { after } },
        }),
      ),
    placeholderData: keepPreviousData,
  });

  const regions = page.data?.regions;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Regions
            {page.isFetching && !page.isPending ? <Spinner /> : null}
          </CardTitle>
          <CardDescription>
            Where this Store sells, and what each place pays in. A Region selects one of
            the currencies this Store has enabled — tax and shipping hang off it later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Problem
            problem={
              page.isError
                ? problemOf(page.error, "The Regions could not be read.")
                : null
            }
          />

          {page.isPending ? <RegionsLoading /> : null}

          {regions !== undefined && regions.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <GlobeIcon />
                </EmptyMedia>
                <EmptyTitle>No Regions yet</EmptyTitle>
                <EmptyDescription>
                  A deployment is seeded one at its first boot, named after the currency
                  it prices in. If there are none here, this Store has not been booted
                  since Regions arrived — define one below.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}

          {regions !== undefined && regions.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">Open</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {regions.map((region) => (
                  <TableRow key={region.id}>
                    <TableCell className="font-medium">{region.name}</TableCell>
                    <TableCell className="font-mono text-sm">{region.currency}</TableCell>
                    <TableCell>
                      <LinkButton
                        to={`/regions/${region.id}`}
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

          <Pager nextCursor={page.data?.nextCursor} label="Regions" />
        </CardContent>
      </Card>

      <NewRegion />
    </div>
  );
}

/** A page of Regions, before there is one. */
function RegionsLoading() {
  return (
    <div className="grid gap-3" role="status" aria-label="Reading the Regions">
      {["first", "second", "third"].map((row) => (
        <Skeleton key={row} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * The shape of the form, and only the shape (ADR-0063).
 *
 * `min(1)` on each field is that field being required. **Whether the currency is one this Store
 * has enabled is not checked here**: that is a rule about the Store, kobai owns it, and a
 * browser that predicted it would be wrong the moment a colleague enabled another in the tab
 * next door.
 */
const NewRegionForm = z.object({
  name: z.string().min(1, "A Region is named — the place, as you would say it."),
  currency: z.string().min(1, "A Region prices in one of this Store's currencies."),
});

type NewRegionValues = z.infer<typeof NewRegionForm>;

/** A Region, which is a name and a currency this Store already has. */
function NewRegion() {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const unavailable = useUnavailable(PERMISSIONS.storeWrite, "define a Region");
  const currencies = useEnabledCurrencies();

  const form = useForm<NewRegionValues>({
    resolver: zodResolver(NewRegionForm),
    defaultValues: { name: "", currency: "" },
  });

  const create = useMutation({
    mutationFn: async (values: NewRegionValues) =>
      orThrow(
        await client.POST("/admin/regions", {
          body: { name: values.name, currency: values.currency },
        }),
      ),
    onSuccess: () => form.reset(),
    // Read back rather than patched in: there is no optimistic update anywhere in this Admin
    // (ADR-0063), and what a Region looks like once kobai holds it is kobai's answer.
    onSettled: () => queries.invalidateQueries({ queryKey: [REGIONS] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>New Region</CardTitle>
        <CardDescription>
          A name and one of this Store's currencies. Names are not unique — kobai
          addresses a Region by its identifier — and kobai converts nothing, so a Variant
          with no Price in that currency has no price there.
        </CardDescription>
      </CardHeader>
      {/* No guard of its own: Enter in a field is implicit submission, which a browser
          performs by clicking this form's default button — the `ActionButton` below, whose
          handler is the no-op for a Merchant who may not define one. */}
      <form onSubmit={form.handleSubmit((values) => create.mutate(values))}>
        <CardContent className="grid gap-6">
          <Problem
            problem={create.isError ? whyNotCreated(create.error) : null}
            title="The Region was not created."
          />
          <FormField
            id="new-region-name"
            label="Name"
            placeholder="Malaysia"
            error={form.formState.errors.name}
            {...form.register("name")}
          />
          {/* The same control the Region screen's currency field is, over the same set and read
              the same way (#300): a Merchant asked for a currency here and asked for one there is
              being asked one question, so a named row on one screen and a bare code on the other
              would be this Admin disagreeing with itself. **Strictly closed**, unlike the Store
              screen's enable field — what a Region may price in is what kobai has enabled, and
              `currency-not-enabled` is a real refusal rather than a gap in a browser's list.

              **The three states are told apart, and a failed read is the one that was missing**
              (#311). `answered` already kept *this Store prices in one currency* off a list that
              was empty because nobody had asked yet; a read that failed is empty for a third
              reason, and both of the other sentences are wrong about it — one sends a Merchant
              to enable a currency they may well have, the other offers a list that is not
              coming. */}
          <ComboboxField
            control={form.control}
            name="currency"
            id="new-region-currency"
            label="Currency"
            placeholder="Choose a currency"
            options={currencies.options}
            empty="This Store does not price in that. The Store screen is where a currency is enabled."
            description={
              whyCurrenciesNotRead(currencies) ??
              (currencies.answered && currencies.options.length <= 1
                ? "This Store prices in one currency. Enable another on the Store screen and it will be offered here."
                : "One of the currencies this Store may price in. The Store screen is where another is enabled.")
            }
            disabled={currencies.error !== null}
          />
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton
            type="submit"
            unavailable={unavailable}
            disabled={create.isPending}
          >
            {create.isPending ? <Spinner /> : null}
            Create Region
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * Why kobai turned the creation back, in words a Merchant can act on.
 *
 * Exhaustive over `RegionRefusal`, and the `never` at the bottom is what keeps it so: a reason
 * added to that family in Core has no arm here and reddens this build in the same commit
 * (ADR-0063).
 */
function whyNotCreated(thrown: unknown): string {
  const fallback = "The Region could not be created.";
  const reason = regionReasonOf(thrown);

  switch (reason) {
    case "currency-not-enabled":
      // The one refusal this form can really meet: a colleague disabled the currency between
      // this picker being filled and the submit, or the page has been open a while.
      return "This Store does not price in that currency. Enable it on the Store screen first — a Region may only select a currency the Store has.";

    case "invalid":
    case "malformed-body":
      // kobai's own prose names the field, which is more than this screen knows.
      return problemOf(thrown, fallback);

    case "region-not-found":
    case "region-in-use":
      // Refusals of a change or a deletion, not reachable from a creation.
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
