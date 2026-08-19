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

/** One thing on offer: the name kobai knows it by, and what the picker calls it. */
export type ListboxOption = {
  readonly value: string;
  readonly label: string;
};

/**
 * One field of a form whose control is a listbox over a set kobai names (#245).
 *
 * **This exists because the second one was not the last one.** Two fields — the Fulfilment
 * Strategy picker and the Merchants roster's Role picker — composed the vendored `Select`
 * identically, and #239 found three defects in that composition that the type checker cannot
 * see: `Select` not handed `items`, so `Select.Value` rendered the raw value under an option
 * reading something else; options not wrapped in a `SelectGroup`, which is where this
 * distribution's popup padding lives; and `""` handed over for "nothing selected" where Base UI
 * means `null`. Every one of them was then fixed **twice, by hand** (#244). A third picker
 * composed from `ui/select.tsx` gets to reintroduce all three and nothing goes red, so the
 * composition is written here once and got right here once.
 *
 * What it decides on the caller's behalf, and none of it is a preference:
 *
 * - **`useController`, because a listbox is not an `<input>` and cannot be `register`ed.** The
 *   form still owns the value, so validation, `formState.errors` and `reset` work here exactly
 *   as they do for a `FormField` beside it — which a `useState` next to the form would have
 *   quietly given up.
 * - **One list draws both the options and `items`.** That is Base UI's documented shape and the
 *   only thing that makes the trigger's text and the option agree about the same value.
 * - **The value the list does not carry is offered anyway**, so the picker can show and stay on
 *   what the record actually points at. It is reachable two ways and both are ordinary: the
 *   list is still in flight, or it does not carry that value at all — which is what
 *   `unlisted` is for saying.
 * - **`null` is "nothing selected", and a `null` back is dropped.** The *form* still holds `""`
 *   for the untouched field, which is the value a schema refuses; `null` is only what `Select`
 *   is handed. Every field on this shape is one a record must be on, so clearing it would
 *   submit an empty name for kobai to refuse.
 * - **The invalid state is set twice**, for the reason `components/form-field.tsx` sets it
 *   twice: `Field` colours itself from `data-invalid` and the trigger announces itself to a
 *   screen reader with `aria-invalid`.
 *
 * What it decides nothing about is the part that is genuinely each caller's: which list this is
 * and how it is read, what to say under the field, and whether the read failed. A caller holds
 * its own query, maps it to {@link ListboxOption}s, and passes the sentence it wants — including
 * the exceptional ones, which is the one thing `quiet` must not swallow.
 */
export function ListboxField<T extends FieldValues>({
  id,
  control,
  name,
  label,
  options,
  placeholder,
  description,
  disabled = false,
  quiet = false,
  unlisted,
}: {
  /** Unique to the **document**, not to the form — two forms on one screen would otherwise
   * point both labels at whichever trigger rendered last. */
  readonly id: string;
  readonly control: Control<T>;
  readonly name: Path<T>;
  /** What the field is called. Rendered `sr-only` whenever {@link quiet} is set, never dropped. */
  readonly label: string;
  /** Everything on offer, in the order it is offered. */
  readonly options: readonly ListboxOption[];
  /** What the trigger reads before anything is chosen. Omit it where the field always has a
   * value, which is what a placeholder would then be lying about. */
  readonly placeholder?: string;
  /** What to say under the field. Omitted says nothing — which is how a {@link quiet} caller
   * drops its standing sentence while still passing the exceptional ones. */
  readonly description?: string;
  /** The field is not usable — a failed read, in every caller so far. */
  readonly disabled?: boolean;
  /** The field is somewhere that already names it, such as a cell under a column heading: the
   * label is rendered `sr-only`, because a column heading is not programmatically the label of
   * a control inside a cell. */
  readonly quiet?: boolean;
  /** What to call the value {@link options} does not carry. Defaults to the value itself, and a
   * caller overrides it where the absence means something a Merchant should be told. */
  readonly unlisted?: (value: string) => string;
}) {
  const { field, fieldState } = useController({ control, name });
  const chosen = chosenValue(field.value);
  const invalid = fieldState.error !== undefined;

  // The one list `Select` resolves the trigger's text against and the one the options are drawn
  // from — with the value nothing on offer carries at its head, so the picker can show it.
  const offered: readonly ListboxOption[] =
    chosen !== null && !options.some((option) => option.value === chosen)
      ? [{ value: chosen, label: unlisted?.(chosen) ?? chosen }, ...options]
      : options;

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id} className={quiet ? "sr-only" : undefined}>
        {label}
      </FieldLabel>
      <Select
        items={offered}
        value={chosen}
        // Base UI reports `null` for "nothing selected", which no field on this shape wants: the
        // value is one a record must be on, and clearing it would submit an empty name for kobai
        // to refuse. A `null` is dropped and the field keeps what it had.
        onValueChange={(next) => {
          if (next !== null) field.onChange(next);
        }}
        disabled={disabled}
      >
        <SelectTrigger
          id={id}
          ref={field.ref}
          onBlur={field.onBlur}
          aria-invalid={invalid}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {/* The list's padding lives on the group in this distribution, so options that are
              not wrapped in one sit flush against the popup's edge. */}
          <SelectGroup>
            {offered.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {description === undefined ? null : (
        <FieldDescription>{description}</FieldDescription>
      )}
      <FieldError errors={[fieldState.error]} />
    </Field>
  );
}

/**
 * The field's value as the name it is, or `null` where it is on none.
 *
 * `useController` types its value as the form's own, which a caller could in principle have
 * declared as anything — so this is the one place the shape is settled, the way
 * `components/permissions-field.tsx` settles its own. `""` arrives here as `null` because that
 * is the untouched field, and `null` is what Base UI means by "nothing selected"; the two
 * agreed by accident before #239, a value serialising to `""` counting as empty for the
 * placeholder, but only `null` says it.
 */
function chosenValue(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
