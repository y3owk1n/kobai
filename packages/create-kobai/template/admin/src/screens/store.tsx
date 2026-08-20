import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ActionButton } from "@/components/action-button";
import { FormField } from "@/components/form-field";
import { ListboxField } from "@/components/listbox-field";
import { Problem } from "@/components/problem";
import { TextareaField } from "@/components/textarea-field";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { PERMISSIONS, useUnavailable } from "@/lib/permissions";
import { orThrow, problemOf, storeReasonOf } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/**
 * What this deployment is: its name, what it prices in, and whatever a Project stashed on it.
 *
 * **One deployment is one Store** (ADR-0005), so this screen takes no identifier and there is
 * no list above it. `GET /admin/store` was reachable by nobody in this Admin until now, and
 * `PATCH /admin/store` did not exist until #172 — a Store's name and metadata were fixed at
 * boot.
 *
 * **The default currency is readable and does not move**, which is #172's decision and
 * ADR-0065's record of it. That is the one thing on this screen the Admin has to reflect
 * honestly rather than offer: every Price carries the Store's default currency and no other
 * (#5), so changing the column would reinterpret each amount already stored rather than convert
 * it — `PATCH` accepts the code the Store already prices in, changes nothing by it, and refuses
 * any other with `default-currency-is-fixed`. An editable box that was always going to be
 * turned back is exactly the affordance ADR-0063 says not to draw, so the value is shown, read
 * only, with the reason beside it.
 */
const STORE = "store";

export function StoreScreen() {
  const client = useKobaiClient();

  const store = useQuery({
    queryKey: [STORE],
    queryFn: async () => orThrow(await client.GET("/admin/store")),
  });

  if (store.isPending) return <StoreLoading />;

  if (store.isError) {
    return (
      <Problem
        title="The Store could not be read."
        problem={problemOf(store.error, "kobai did not answer.")}
      />
    );
  }

  return (
    <div className="grid gap-6">
      <StoreSettings
        name={store.data.name}
        defaultCurrency={store.data.defaultCurrency}
        metadata={store.data.metadata}
      />
      <Currencies
        defaultCurrency={store.data.defaultCurrency}
        currencies={store.data.currencies}
      />
      <DefaultRegion current={store.data.defaultRegion} />
    </div>
  );
}

/**
 * The shape of the form, and only the shape (ADR-0063).
 *
 * The metadata field is where "shape only" has to be argued rather than asserted: **whether the
 * text is JSON at all, and whether it is an object, is structure** — `metadata` is
 * `Record<string, unknown>` in kobai's own schema, and a browser that posted a string where an
 * object belongs would be sending a body the route cannot read. What is *in* the object is
 * nobody's business here: it is unindexed, untyped JSON owned by the Merchant and the Project,
 * so nothing below inspects a key or a value.
 */
const StoreForm = z.object({
  name: z.string().min(1, "A Store is called something."),
  metadata: z.string().transform((typed, ctx): Record<string, unknown> => {
    const text = typed.trim();
    // An emptied box means an empty object rather than "leave it alone", and that is a
    // Merchant deleting something they can see rather than a form quietly discarding it —
    // which is the distinction that keeps `metadata` editable at all (ADR-0062: a named
    // `metadata` replaces, and never merges).
    if (text === "") return {};

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Metadata is JSON, and this is not JSON kobai could read.",
      });
      return z.NEVER;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      ctx.addIssue({
        code: "custom",
        message:
          'Metadata is a JSON object — `{ "key": "value" }`, not a list or a number.',
      });
      return z.NEVER;
    }

    return parsed as Record<string, unknown>;
  }),
});

type StoreInput = z.input<typeof StoreForm>;
type StoreValues = z.output<typeof StoreForm>;

/**
 * The Store, as a form.
 *
 * `name` and `metadata` are always sent and `defaultCurrency` never is — an absent field means
 * "leave it" (ADR-0062), which is exactly what the currency wants, and it also keeps this form
 * clear of the one refusal it could otherwise cause by accident: a body naming *only* the
 * currency the Store already has changes nothing and is refused at 400.
 */
function StoreSettings({
  name,
  defaultCurrency,
  metadata,
}: {
  readonly name: string;
  readonly defaultCurrency: string;
  readonly metadata: Record<string, unknown>;
}) {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const unavailable = useUnavailable(PERMISSIONS.storeWrite, "change the Store");

  const form = useForm<StoreInput, unknown, StoreValues>({
    resolver: zodResolver(StoreForm),
    // `values` rather than `defaultValues`, so a save that landed leaves both fields showing
    // what kobai now holds — including a `metadata` kobai reordered or normalised.
    values: { name, metadata: writeMetadata(metadata) },
  });

  const save = useMutation({
    mutationFn: async (values: StoreValues) =>
      orThrow(
        await client.PATCH("/admin/store", {
          body: { name: values.name, metadata: values.metadata },
        }),
      ),
    // Re-read rather than patched in place (ADR-0063): what the Store looks like once kobai
    // holds it is kobai's answer.
    onSuccess: () => void queries.invalidateQueries({ queryKey: [STORE] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Store</CardTitle>
        <CardDescription>
          One deployment is one Store, so there is one of these and it has no identifier
          (ADR-0005).
        </CardDescription>
      </CardHeader>
      <form onSubmit={form.handleSubmit((values) => save.mutate(values))}>
        <CardContent className="grid gap-6">
          <Problem
            problem={save.isError ? whyNotChanged(save.error) : null}
            title="The Store was not changed."
          />

          <FormField
            id="store-name"
            label="Name"
            error={form.formState.errors.name}
            {...form.register("name")}
          />

          <Field>
            <FieldLabel htmlFor="store-default-currency">Default currency</FieldLabel>
            {/* `readOnly` rather than `disabled`: the value is worth reading and worth
                copying, a read-only input is still reachable by keyboard and still announced,
                and a disabled one is neither. It is also not the `aria-disabled` an
                unavailable *action* gets — nothing here is an action, and the explanation is
                beside the field rather than in a tooltip. */}
            <Input
              id="store-default-currency"
              readOnly
              value={defaultCurrency}
              className="bg-muted/50"
            />
            <FieldDescription>
              Fixed. A Price that names no Region and no Channel carries this code, so
              moving it would reinterpret each of those amounts rather than convert them —
              kobai refuses the change (ADR-0065, ADR-0074). A second currency is{" "}
              <strong>enabled</strong> below and selected on a Region; it never replaces
              this one.
            </FieldDescription>
          </Field>

          <TextareaField
            id="store-metadata"
            label="Metadata"
            rows={6}
            spellCheck={false}
            className="font-mono text-sm"
            error={form.formState.errors.metadata}
            description={
              <>
                Unindexed, untyped JSON owned by you and by this Project — kobai stores it
                and reads nothing in it. Saving <strong>replaces</strong> what is stored
                rather than merging into it, so what is in the box is what the Store will
                have.
              </>
            }
            {...form.register("metadata")}
          />
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton type="submit" unavailable={unavailable} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save Store
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * The shape of the currencies form, and only the shape (ADR-0063).
 *
 * Three letters is what the column's own `char_length` check holds, and it is structure rather
 * than a rule: **whether a code is one this Store may enable is nothing a browser can decide**,
 * and neither is whether it is a real ISO 4217 code — kobai does not hold a table of the world
 * either, deliberately, so a list here would be one more place to go stale.
 */
const CurrenciesForm = z.object({
  typed: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, "An ISO 4217 code is three letters — USD, MYR, EUR."),
});

type CurrenciesValues = z.infer<typeof CurrenciesForm>;

/**
 * Every currency this Store may price in, and the way to enable another (#291, ADR-0074).
 *
 * **The whole set travels on every write**, because that is how kobai reads the field: enabling
 * sends what is here plus the new code, and disabling sends what is here minus one. A list of
 * edits would leave no way to say *and this one is gone*, which is the same bargain a Product's
 * `collections` takes.
 *
 * **The default currency's row has no Remove control**, and that is an affordance rather than
 * the boundary: kobai refuses a set that leaves it out (`default-currency-must-be-enabled`), and
 * a button that was always going to be turned back is exactly what ADR-0063 says not to draw.
 * Every other row's Remove is offered and attempted — whether a Region selects that currency is
 * a fact kobai holds, so this screen asks rather than predicts, and renders the refusal naming
 * the Regions when it comes back.
 */
function Currencies({
  defaultCurrency,
  currencies,
}: {
  readonly defaultCurrency: string;
  readonly currencies: readonly { readonly code: string }[];
}) {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const unavailable = useUnavailable(PERMISSIONS.storeWrite, "change the Store");

  const form = useForm<CurrenciesValues>({
    resolver: zodResolver(CurrenciesForm),
    defaultValues: { typed: "" },
  });

  const write = useMutation({
    mutationFn: async (codes: readonly string[]) =>
      orThrow(
        await client.PATCH("/admin/store", {
          body: { currencies: codes.map((code) => ({ code })) },
        }),
      ),
    // Read back rather than patched in place (ADR-0063), and both queries: the picker on the
    // Regions screens reads this same set through its own key.
    onSuccess: () => {
      form.reset();
      void queries.invalidateQueries();
    },
  });

  const enabled = currencies.map((one) => one.code);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Currencies</CardTitle>
        <CardDescription>
          What this Store may price in. A Region selects one of these, and a Price is
          denominated in one of these — kobai converts nothing, so a Variant with no Price
          in a currency has no price in it.
        </CardDescription>
      </CardHeader>
      <form
        onSubmit={form.handleSubmit((values) =>
          write.mutate([...enabled, values.typed.toUpperCase()]),
        )}
      >
        <CardContent className="grid gap-6">
          <Problem
            problem={write.isError ? whyNotChanged(write.error) : null}
            title="The currencies were not changed."
          />

          <ul className="grid gap-2">
            {currencies.map((one) => (
              <li
                key={one.code}
                className="flex items-center justify-between gap-4 rounded-md border px-3 py-2"
              >
                <span className="font-mono text-sm">
                  {one.code}
                  {one.code === defaultCurrency ? (
                    <span className="ml-2 font-sans text-muted-foreground text-xs">
                      the default
                    </span>
                  ) : null}
                </span>
                {one.code === defaultCurrency ? null : (
                  <ActionButton
                    type="button"
                    variant="outline"
                    size="sm"
                    unavailable={unavailable}
                    disabled={write.isPending}
                    onClick={() =>
                      write.mutate(enabled.filter((code) => code !== one.code))
                    }
                  >
                    Disable {one.code}
                  </ActionButton>
                )}
              </li>
            ))}
          </ul>

          <FormField
            id="store-enable-currency"
            label="Enable another"
            placeholder="MYR"
            description="An ISO 4217 code. Enabling one is not the same as having Prices in it — set those on each Variant."
            error={form.formState.errors.typed}
            {...form.register("typed")}
          />
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton
            type="submit"
            unavailable={unavailable}
            disabled={write.isPending}
          >
            {write.isPending ? <Spinner /> : null}
            Enable currency
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * Which Region a storefront that names none is answered for (#291, ADR-0074).
 *
 * **A field of the Store rather than a flag on a row in the Regions list**, because one
 * deployment has one of these — and because a Merchant deciding it is deciding something about
 * the Store rather than about that Region.
 *
 * A deployment is seeded one at its first boot, so `null` here means this Store has not been
 * booted since Regions arrived; the card says so rather than showing an empty picker with no
 * explanation.
 */
function DefaultRegion({
  current,
}: {
  readonly current: { readonly id: string; readonly name: string } | null;
}) {
  const client = useKobaiClient();
  const queries = useQueryClient();
  const unavailable = useUnavailable(PERMISSIONS.storeWrite, "change the Store");
  const regions = useQuery({
    queryKey: [OFFERED_REGIONS],
    queryFn: async () =>
      orThrow(
        await client.GET("/admin/regions", {
          params: { query: { limit: OFFERED_REGION_LIMIT } },
        }),
      ),
  });

  const form = useForm<{ defaultRegion: string }>({
    // `values` rather than `defaultValues`, so a save that landed leaves the picker showing what
    // kobai now holds. `""` is the untouched field, which the submit below refuses to send.
    values: { defaultRegion: current?.id ?? "" },
  });

  const save = useMutation({
    mutationFn: async (id: string) =>
      orThrow(await client.PATCH("/admin/store", { body: { defaultRegion: id } })),
    onSuccess: () => void queries.invalidateQueries(),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Default Region</CardTitle>
        <CardDescription>
          What a storefront is answered for when it asks for a price without naming a
          Region. Every deployment is seeded one at its first boot, named after the
          currency it prices in.
        </CardDescription>
      </CardHeader>
      <form
        onSubmit={form.handleSubmit((values) => {
          if (values.defaultRegion !== "") save.mutate(values.defaultRegion);
        })}
      >
        <CardContent className="grid gap-6">
          <Problem
            problem={save.isError ? whyNotChanged(save.error) : null}
            title="The default Region was not changed."
          />
          <ListboxField
            control={form.control}
            name="defaultRegion"
            id="store-default-region"
            label="Region"
            placeholder="Choose a Region"
            options={(regions.data?.regions ?? []).map((region) => ({
              value: region.id,
              label: `${region.name} — ${region.currency}`,
            }))}
            description={
              regions.isSuccess && (regions.data?.regions.length ?? 0) === 0
                ? "This Store has no Regions. Define one on the Regions screen, and a storefront that names none will be answered for it."
                : "The Regions screen is where these are defined. There is no way to have none: something has to answer a storefront that sends no Region."
            }
          />
        </CardContent>
        <CardFooter className="mt-4">
          <ActionButton type="submit" unavailable={unavailable} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save default Region
          </ActionButton>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * How many Regions the default picker offers, and the gap that comes with it.
 *
 * It does not page, which is `lib/collections.ts`'s known gap one noun along: a cursor inside
 * this card would sit in an address that already locates the Store screen. A Store with more
 * than a hundred Regions and an old one to pick is the case that reaches it, and the Regions
 * section is where every one of them can be found.
 */
const OFFERED_REGION_LIMIT = 100;

/** Its own cache key, deliberately not the Regions screen's — see `lib/store.ts`. */
const OFFERED_REGIONS = "offered-regions";

/**
 * The Store's metadata as something a person can edit.
 *
 * Indented, because the alternative is one long line a Merchant has to scroll to find a key
 * in. An empty object renders as the empty string rather than as `{}` — there is nothing to
 * edit, and a box that starts full of punctuation reads as something having gone wrong.
 */
function writeMetadata(metadata: Record<string, unknown>): string {
  return Object.keys(metadata).length === 0 ? "" : JSON.stringify(metadata, null, 2);
}

/** The Store, before it is there. */
function StoreLoading() {
  return (
    <div className="grid gap-6" role="status" aria-label="Reading the Store">
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/**
 * Why kobai refused the change, in words a Merchant can act on.
 *
 * Exhaustive over `StoreRefusal`, and the `never` keeps it so. `default-currency-is-fixed`
 * cannot arrive from this form, which never sends a currency — but the family is closed, the
 * compiler counts the arms, and a refusal reachable from somewhere else still has to be
 * legible when it turns up.
 */
function whyNotChanged(thrown: unknown): string {
  const fallback = "kobai would not make that change.";
  const reason = storeReasonOf(thrown);

  switch (reason) {
    case "default-currency-is-fixed":
      return "This Store's default currency does not move: every Price that names no Region and no Channel carries it, so changing it would reinterpret those amounts rather than convert them (ADR-0065). Enable the currency you meant instead, and select it on a Region.";

    case "default-currency-must-be-enabled":
      return "The default currency has to stay enabled — it is what a Price carrying no Region and no Channel is denominated in.";

    case "currency-in-use":
      // kobai's own prose names the Regions, which is more than this screen knows: a Store with
      // twenty of them cannot act on "one of them".
      return problemOf(
        thrown,
        "A Region prices in that currency, so it cannot be disabled.",
      );

    case "region-not-found":
      return "That Region is no longer there — somebody else deleted it, or this page has been open a while. Choose another.";

    case "invalid":
    case "malformed-body":
      // kobai's own prose names the field, which is more than this screen knows.
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
