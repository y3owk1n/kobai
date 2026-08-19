import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ActionButton } from "@/components/action-button";
import { FormField } from "@/components/form-field";
import { Problem } from "@/components/problem";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
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
    <StoreSettings
      name={store.data.name}
      defaultCurrency={store.data.defaultCurrency}
      metadata={store.data.metadata}
    />
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
              Fixed. Every Price this Store holds carries this code and no other, so
              moving it would reinterpret each amount already entered rather than convert
              it — kobai refuses the change (ADR-0065). A second currency arrives as more
              Prices, not as a different default.
            </FieldDescription>
          </Field>

          <Field data-invalid={form.formState.errors.metadata !== undefined}>
            <FieldLabel htmlFor="store-metadata">Metadata</FieldLabel>
            <Textarea
              id="store-metadata"
              rows={6}
              spellCheck={false}
              aria-invalid={form.formState.errors.metadata !== undefined}
              className="font-mono text-sm"
              {...form.register("metadata")}
            />
            <FieldDescription>
              Unindexed, untyped JSON owned by you and by this Project — kobai stores it
              and reads nothing in it. Saving <strong>replaces</strong> what is stored
              rather than merging into it, so what is in the box is what the Store will
              have.
            </FieldDescription>
            <FieldError errors={[form.formState.errors.metadata]} />
          </Field>
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
      return "This Store prices in one currency and it does not move: every Price already entered carries it, so changing it would reinterpret those amounts rather than convert them (ADR-0065).";

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
