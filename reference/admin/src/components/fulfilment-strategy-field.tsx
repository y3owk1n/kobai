import { useQuery } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { orThrow, problemOf } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";
import { cn } from "@/lib/utils";

/**
 * The Strategies this deployment has wired, read once and shared by every field below.
 *
 * `GET /admin/fulfilment-strategies` is ADR-0067's route, and it exists because of this screen:
 * a Variant points at a Strategy *by name*, the set is open by design (ADR-0014), and until
 * #179 nothing on the surface could say what the names were. The Admin was left with a text
 * box and a refusal, or with `physical` and `digital` hard-coded — which is the closed set
 * ADR-0014 exists to prevent, written into the client instead of into the schema, and wrong on
 * the first deployment that wires a Plugin's Strategy.
 *
 * The set cannot change while the Project is running, so this is read once and never
 * invalidated by anything. `staleTime: Infinity` says that rather than leaving it to look like
 * an oversight: a restart is a new page load.
 */
const FULFILMENT_STRATEGIES = "fulfilment-strategies";

export function useFulfilmentStrategies() {
  const client = useKobaiClient();

  return useQuery({
    queryKey: [FULFILMENT_STRATEGIES],
    queryFn: async () => orThrow(await client.GET("/admin/fulfilment-strategies")),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Which Strategy a Variant is delivered by — a choice among the ones this deployment has.
 *
 * **A picker rather than a text field, and only because the API can answer.** ADR-0063's rule
 * against predicting refusals is about *rules*, not about vocabularies: whether a name is one
 * of the wired ones is not a judgement the Admin is making, it is a list kobai handed over. A
 * name unwired between this read and the submit is still attempted and still refused with
 * `unknown-fulfilment-strategy`, which is what keeps this an affordance.
 *
 * **It is a native `<select>`, and that is a decision rather than a shortcut.** shadcn's
 * `Select` is a listbox in a **portal**, which puts its options at the end of `<body>`, outside
 * every landmark — and `axe-core` reports exactly that, as `region`, on the one screen this
 * Admin audits with a picker open. The tooltip's portal was excused because its content is
 * announced another way and can be hidden from the accessibility tree (see
 * `components/action-button.tsx`); a list of options a Merchant has to choose from cannot be.
 * What is wanted here is a form control inside a form — two or three names, no search, no
 * grouping, no icons — which is the one job the platform's own control does better than a
 * `div` tree. It also means react-hook-form can `register` it like every other field, so the
 * value lives with the rest of the form instead of in a `useState` beside it.
 *
 * shadcn is still what it is built out of: `Field`, `FieldLabel`, `FieldDescription` and
 * `FieldError` are all theirs, and the control carries `Input`'s own classes, so it is tuned by
 * the same tokens as everything else (ADR-0063).
 *
 * **A failed read blocks nothing.** The field goes unavailable and says so, and the form around
 * it still submits — `fulfilment` is optional on both routes that take it, so correcting a SKU
 * does not stop because a second request did.
 */
export function FulfilmentStrategyField({
  id,
  current,
  description,
  error,
  className,
  ...select
}: {
  readonly id: string;
  /**
   * What this Variant points at now, so a Strategy nobody wired is still offered.
   *
   * The one state this screen exists to repair: a Variant left pointing at a Strategy the
   * deployment has since unwired, which `place-order` refuses at 409 and which before #144
   * could only be mended by deleting the Product. Leaving it out of the options would show the
   * Merchant a picker that silently disagrees with the Variant in front of them.
   */
  readonly current?: string;
  readonly description?: string;
  readonly error?: { readonly message?: string } | undefined;
} & Omit<ComponentProps<"select">, "id" | "children">) {
  const strategies = useFulfilmentStrategies();
  const wired = strategies.data?.strategies ?? [];
  const unwired =
    current !== undefined &&
    current !== "" &&
    !wired.some((strategy) => strategy.name === current);

  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel htmlFor={id}>Fulfilment Strategy</FieldLabel>
      <select
        id={id}
        aria-invalid={error !== undefined}
        disabled={strategies.isError}
        className={cn(
          "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
          className,
        )}
        {...select}
      >
        {unwired ? <option value={current}>{current} — not wired here</option> : null}
        {wired.map((strategy) => (
          <option key={strategy.name} value={strategy.name}>
            {strategy.name}
          </option>
        ))}
      </select>
      <FieldDescription>
        {strategies.isError
          ? problemOf(strategies.error, "kobai did not say which Strategies it has.")
          : (description ??
            "What a Variant is delivered by. This deployment wired these; a Plugin's is added in the Project's kobai.config.ts.")}
      </FieldDescription>
      <FieldError errors={[error]} />
    </Field>
  );
}
