import { useQuery } from "@tanstack/react-query";
import {
  type Control,
  type FieldValues,
  type Path,
  useController,
} from "react-hook-form";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { orThrow, problemOf } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

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
 * **It is shadcn's `Select`, and getting there took a fix in the frame rather than a different
 * control.** Base UI portals the list out of the card it was opened from, which by default
 * means `<body>` — outside every landmark, which `axe-core` fails the build on as `region` the
 * moment a browser case audits a screen with it open. The answer is `lib/portal.tsx`: the frame
 * offers a container inside `main` and `ui/select.tsx` renders into it, so the list escapes its
 * card's stacking context exactly as before and lands somewhere the document's outline accounts
 * for. A native `<select>` was the other way out and was rejected — it would have been the one
 * control in this Admin that shadcn did not draw, and the landmark problem would still have
 * been waiting for the next menu or popover.
 *
 * **It is driven through `useController`** because a listbox is not an `<input>` and cannot be
 * `register`ed. The form still owns the value, so validation, `formState.errors` and `reset`
 * work here exactly as they do for the SKU beside it — which a `useState` next to the form
 * would have quietly given up.
 *
 * **A failed read blocks nothing.** The field goes unavailable and says so, and the form around
 * it still submits — `fulfilment` is optional on both routes that take it, so correcting a SKU
 * does not stop because a second request did.
 */
export function FulfilmentStrategyField<T extends FieldValues>({
  id,
  control,
  name,
  description,
}: {
  readonly id: string;
  readonly control: Control<T>;
  readonly name: Path<T>;
  readonly description?: string;
}) {
  const strategies = useFulfilmentStrategies();
  const { field, fieldState } = useController({ control, name });
  const wired = strategies.data?.strategies ?? [];

  /**
   * Whether "this deployment does not have that Strategy" is a thing we actually know.
   *
   * **Only once the read succeeded.** While it is in flight `wired` is empty, so every Variant
   * looks unwired — and labelling an ordinary `physical` one "not wired here" for the length of
   * a round trip announces exactly the broken state this screen exists to *repair*, about a
   * Variant that is fine. A failed read is the same mistake made permanently.
   */
  const known = strategies.isSuccess;

  /**
   * The Strategy this field is on, or `null` where it is on none.
   *
   * **`null` rather than `""`, because `null` is what Base UI means by "nothing selected".**
   * The two agreed by accident — a value serialising to `""` counts as empty for the
   * placeholder — but only `null` says it. The *form* still holds `""` for the untouched
   * field, which is the value the schema refuses; `null` is what `Select` is handed.
   */
  const chosen =
    typeof field.value === "string" && field.value !== "" ? field.value : null;

  /**
   * The value this field is on, when the list does not carry it.
   *
   * Offered regardless, so the picker can show and stay on the Strategy the Variant actually
   * points at — and named "not wired here" only once {@link known}, because until then every
   * Variant looks unwired.
   */
  const unwired =
    chosen !== null && !wired.some((strategy) => strategy.name === chosen)
      ? { value: chosen, label: known ? `${chosen} — not wired here` : chosen }
      : null;

  /**
   * What each Strategy on offer is called: the one list the options are drawn from, and the
   * one `Select` resolves the trigger's text against.
   *
   * **`items` is how `Select.Value` renders a label rather than the raw value.** Without it
   * the trigger and the list disagreed about the same Strategy — the option read
   * `physical — not wired here` while the trigger under it read `physical`.
   */
  const items = [
    ...(unwired ? [unwired] : []),
    ...wired.map((strategy) => ({ value: strategy.name, label: strategy.name })),
  ];

  return (
    <Field data-invalid={fieldState.error !== undefined}>
      <FieldLabel htmlFor={id}>Fulfilment Strategy</FieldLabel>
      <Select
        items={items}
        value={chosen}
        // Base UI reports `null` for "nothing selected", which this field never wants: a Variant
        // always points at some Strategy, and clearing it would submit an empty name for kobai
        // to refuse. A `null` is dropped and the field keeps what it had.
        onValueChange={(next) => {
          if (next !== null) field.onChange(next);
        }}
        disabled={strategies.isError}
      >
        <SelectTrigger
          id={id}
          ref={field.ref}
          onBlur={field.onBlur}
          aria-invalid={fieldState.error !== undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {/* The list's padding lives on the group in this distribution, so options that are
              not wrapped in one sit flush against the popup's edge. */}
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldDescription>
        {strategies.isError
          ? problemOf(strategies.error, "kobai did not say which Strategies it has.")
          : (description ??
            "What a Variant is delivered by. This deployment wired these; a Plugin's is added in the Project's kobai.config.ts.")}
      </FieldDescription>
      <FieldError errors={[fieldState.error]} />
    </Field>
  );
}
