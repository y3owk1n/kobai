import { useCallback, useMemo, useState } from "react";
import {
  type Control,
  type FieldValues,
  type Path,
  useController,
} from "react-hook-form";
import { chosenValue, type ListboxOption } from "@/components/listbox-field";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";

/**
 * One field of a form whose control is a **filterable** listbox — a picker you can type into
 * (#300).
 *
 * **It is `components/listbox-field.tsx` for a list too long to look through**, and the two are
 * deliberately separate components rather than one with a `filterable` flag. Base UI says which
 * to reach for: a `Select` is a listbox with no input, a `Combobox` is the same list behind one,
 * and "prefer Combobox when the number of items is sufficiently large to warrant filtering". A
 * search box over the four Permissions or the two Fulfilment Strategies a deployment wired is
 * noise; ISO 4217 is around three hundred entries, and a Merchant who knows they want `MYR` has
 * no business scrolling for it. The dividing line is the list, so it is the caller who knows,
 * and a flag would only have hidden the choice inside a prop.
 *
 * Everything the two have in common they hold for the same reasons, and those are argued at
 * length in `listbox-field.tsx` rather than repeated here:
 *
 * - **`useController`, because this is not an `<input>` a form can `register`.** The form still
 *   owns the value, so validation, `formState.errors` and `reset` work as they do for a
 *   `FormField` beside it.
 * - **One list draws the options and `items` both**, which is what makes the text in the box and
 *   the row in the list agree about the same value.
 * - **The chosen value is offered whether or not the list carries it**, so the picker can show
 *   and stay on what the record actually points at while the list behind it is still in flight.
 * - **`null` is "nothing chosen", and a `null` back is dropped**: every field on this shape is
 *   one a record must be on, so clearing it would submit an empty name for kobai to refuse. The
 *   settling of `""` into that `null` is `chosenValue`, imported from there rather than written
 *   again here — one line, and a rule that would drift.
 * - **The invalid state is set twice** — `Field` colours itself from `data-invalid`, and the
 *   control announces itself with `aria-invalid`.
 *
 * Three things are this component's own, and each comes from there being a box to type in.
 *
 * **What is typed filters against the label rather than the value**, which is Base UI's own
 * behaviour once it is told how to read an item — so `myr` and `ringgit` reach the same row, and
 * a caller that puts both a code and a name in its label gets both for nothing.
 *
 * **The box lives inside the popup, and that is not a matter of taste.** Base UI offers both
 * arrangements, and with the input outside — the shape that looks like a text field you can type
 * in — its focus manager is **modal**: while the list is open everything the popup is not is
 * `aria-hidden`, including this field's own label and the frame's `h1`. axe reports three
 * violations for it (`label`, `page-has-heading-one`, `aria-hidden-focus`), which is a red gate
 * rather than a preference, and it is a real one: a Merchant on a screen reader loses the name
 * of the very field they are filling in. Inside, the popup is a `role="dialog"` and the page
 * behind it stays readable. Both were built and the browser seam was watched failing on the
 * first.
 *
 * **So this needs none of the portal plumbing `ui/select.tsx` carries** — axe excludes a
 * `role="dialog"` subtree from the `region` rule, which is the same reason `ui/dialog.tsx` is
 * left alone (`components/ui/README.md`). `ui/combobox.tsx` is exactly what `shadcn add` wrote.
 *
 * **A caller may let a Merchant type a value that is on no row** — {@link novel} — and whether it
 * may is the caller's question rather than this component's, because it is a question about what
 * kobai will accept. A Region's currency must be one the Store enabled, so that picker is closed
 * and typing something else finds nothing; the Store's *enable* field is the only way a Merchant
 * reaches a route that takes any three-character code, so a browser's gap in `Intl` must not
 * become kobai's. Closed is the default: a picker fences only where something already fenced.
 */
export function ComboboxField<T extends FieldValues, Submitted extends FieldValues = T>({
  id,
  control,
  name,
  label,
  options,
  placeholder,
  search = "Type to narrow this list",
  description,
  empty = "Nothing here matches that.",
  disabled = false,
  novel,
}: {
  /** Unique to the **document**, not to the form. */
  readonly id: string;
  /** The form this field belongs to. `Submitted` is what its `onSubmit` receives, which differs
   * from what the fields hold only where the schema transforms — see `listbox-field.tsx`. */
  readonly control: Control<T, unknown, Submitted>;
  readonly name: Path<T>;
  readonly label: string;
  /** Everything on offer, in the order it is offered. What a Merchant types is matched against
   * the **label**, so a label carrying both the code and the name is searchable by either. */
  readonly options: readonly ListboxOption[];
  /** What the control reads before anything is chosen. Omit it where the field always has a
   * value, which is what a placeholder would then be lying about. */
  readonly placeholder?: string;
  /** What the search box inside the popup reads. */
  readonly search?: string;
  /** What to say under the field. */
  readonly description?: string;
  /** What the popup says when nothing matches what was typed. */
  readonly empty?: string;
  /**
   * The field is not usable — a read that failed, in the one caller that passes it.
   *
   * It goes on the root rather than on the trigger, which is where Base UI reads it from and
   * what puts the whole control — the trigger and the box inside the popup alike — out of use.
   */
  readonly disabled?: boolean;
  /**
   * What to offer for text that is on no row, or `null` for nothing — which is the default, and
   * a picker a Merchant cannot type their way out of.
   *
   * It is handed what was typed and answers the option to put at the head of the list, so the
   * caller owns both halves of the question: whether the text is something kobai would take, and
   * what to call it in a list of rows that are all real. Choosing it puts **its `value`** in the
   * form, so a caller that means "upper case, trimmed" says so here.
   */
  readonly novel?: (typed: string) => ListboxOption | null;
}) {
  const { field, fieldState } = useController({ control, name });
  const chosen = chosenValue(field.value);
  const invalid = fieldState.error !== undefined;

  // What is in the search box, which this component holds only so {@link novel} can be asked
  // about it. Base UI owns the box itself — this is `onInputValueChange` listening in, never
  // `inputValue` taking it over, so none of the clearing and re-filling it does on open, close
  // and selection has to be reimplemented here.
  const [typed, setTyped] = useState("");
  const invented = novel?.(typed) ?? null;

  // The one list the box's text is resolved against and the one the rows are drawn from. Two
  // things sit at its head, and neither is on offer in the ordinary sense: the value the record
  // already points at, so the picker can show and stay on it, and what a Merchant has typed that
  // is on no row. Memoised because `Combobox` watches `items` for identity.
  const offered = useMemo(() => {
    const carried = [...options];
    if (chosen !== null && !carried.some((option) => option.value === chosen)) {
      carried.unshift({ value: chosen, label: chosen });
    }
    if (invented !== null && !carried.some((option) => option.value === invented.value)) {
      carried.unshift(invented);
    }
    return carried;
  }, [options, chosen, invented]);

  // The items are the codes rather than the `{ value, label }` pairs, so what the form holds and
  // what `Combobox` compares are the same string. The map is how one is read — for the text on
  // the trigger, and for what typing is matched against — and it is a map rather than a search
  // because both of those ask per row, over a list that can run to hundreds.
  const values = useMemo(() => offered.map((option) => option.value), [offered]);
  const labels = useMemo(
    () => new Map(offered.map((option) => [option.value, option.label])),
    [offered],
  );
  const labelOf = useCallback((value: string) => labels.get(value) ?? value, [labels]);

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Combobox
        items={values}
        value={chosen}
        itemToStringLabel={labelOf}
        // Base UI reports `null` for "nothing chosen", which no field on this shape wants: see
        // the note above, and `listbox-field.tsx` for the argument.
        onValueChange={(next) => {
          if (next !== null) field.onChange(next);
        }}
        onInputValueChange={setTyped}
        disabled={disabled}
      >
        <ComboboxTrigger
          id={id}
          ref={field.ref}
          onBlur={field.onBlur}
          aria-invalid={invalid}
          render={<Button variant="outline" />}
          // A placeholder here is **not** dimmed, which every other placeholder in this Admin is
          // and which `SelectTrigger` does through `data-placeholder:text-muted-foreground`. The
          // trigger is a `Button`, so opening it turns its background `muted` — and muted text on
          // a muted background measures below 4.5:1, which `axe-core` fails the build on and a
          // browser case sees, because it audits with the list open. What it costs is that "Choose
          // a currency" reads at full contrast; what a dimmed one would cost is the state a
          // Merchant is in while choosing.
          className="w-full justify-between font-normal"
        >
          <ComboboxValue placeholder={placeholder} />
        </ComboboxTrigger>
        <ComboboxContent aria-label={label}>
          {/* The box is **inside** the popup, which is Base UI's other arrangement for this
              component and the one this Admin can use. With the input outside, Base UI's focus
              manager is modal — it `aria-hidden`s everything the popup is not, including the
              field's own label and the frame's `h1`, and `axe-core` fails the build on all three
              the moment a case audits a screen with the list open. Inside, the popup is a
              `role="dialog"` the page around it stays readable behind, which is also why this
              component needs none of the portal plumbing `ui/select.tsx` carries: axe excludes a
              dialog subtree from the `region` rule. */}
          <ComboboxInput showTrigger={false} placeholder={search} />
          <ComboboxEmpty>{empty}</ComboboxEmpty>
          <ComboboxList>
            {(value: string) => (
              <ComboboxItem key={value} value={value}>
                {labelOf(value)}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {description === undefined ? null : (
        <FieldDescription>{description}</FieldDescription>
      )}
      <FieldError errors={[fieldState.error]} />
    </Field>
  );
}
