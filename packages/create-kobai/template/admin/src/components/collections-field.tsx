import type { Collection } from "@kobai/client";
import type { ReactNode } from "react";
import {
  type Control,
  type FieldValues,
  type Path,
  useController,
} from "react-hook-form";
import { Problem } from "@/components/problem";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { useOfferedCollections } from "@/lib/collections";
import { problemOf } from "@/lib/refusal";

/**
 * Which Collections a Product is in, as a set of checkboxes (#256, #280).
 *
 * **A component on the second use rather than the third**, which is
 * `components/media-attachments.tsx`'s rule and `components/listbox-field.tsx`'s lesson: the
 * Product screen's Collections card and the Products list's New Product form ask a Merchant the
 * same question, and a hand-copied second answer is one that gets fixed once per copy with
 * nothing going red for the one that was missed. What each caller keeps is what is genuinely its
 * own — which set it starts from, what it does with the answer, and what to say where this Store
 * has no Collections at all.
 *
 * **Checkboxes rather than `useFieldArray` with Up and Down**, which is where this parts company
 * with the Media list it sits beside: a Product's Collections are a **set**, so there is no first
 * Collection and nothing to move.
 *
 * **The set is read from kobai, never written down here** (ADR-0063), through
 * `lib/collections.ts` — the same hook the Products list's filter reads, so the three ask one
 * question in one place and inherit the same known gap about the hundred-and-first Collection.
 */
export function CollectionsField<T extends FieldValues, TTransformed = T>({
  idPrefix,
  control,
  name,
  alsoOffer = [],
  whenNone = null,
}: {
  /** Unique to the **document**: two of these on one screen would otherwise share label ids. */
  readonly idPrefix: string;
  /**
   * The form owns the value, exactly as it does for every field beside this one.
   *
   * A set of checkboxes cannot be `register`ed, so it takes `control` and `name` and holds its
   * own `useController` — `components/permissions-field.tsx`'s shape, and the rule the Admin
   * already carries: never a `useState` beside the form, which is what keeps `reset` and
   * `formState` working here like anywhere else.
   *
   * **The transformed type is carried, which `PermissionsField` does not have to do.** A form
   * whose schema `transform`s a field — the New Product form, whose `amount` becomes a number —
   * has a `Control` of three type parameters, and one declared with a single parameter refuses
   * it for a difference in a field this component never reads.
   */
  readonly control: Control<T, unknown, TTransformed>;
  readonly name: Path<T>;
  /**
   * Collections to draw a row for beyond the ones kobai offered — the ones this Product is
   * already in that the offered list did not carry.
   *
   * That is `PermissionsField`'s rule about a word Core has never heard of, arriving here as the
   * hundred-and-first Collection: a picker that quietly dropped one would take the Product out
   * of it on the next save, which is data loss spelled as a form. A Product being *created* is
   * in nothing yet and passes none, which is the same walk with an empty list.
   */
  readonly alsoOffer?: readonly Collection[];
  /**
   * What to show where this Store has no Collections to offer at all.
   *
   * The caller's, because the two have nothing to say in common: a Merchant who opened the
   * Collections card came looking for this and is told where to make one, and a Merchant filling
   * in a new Product did not, so the field simply is not there. Different lists, different prose
   * — the line `useListFilter` already draws for an empty one.
   */
  readonly whenNone?: ReactNode;
}) {
  const { field } = useController({ control, name });
  const chosen = toIdentifiers(field.value);
  const offered = useOfferedCollections();

  const rows = [
    ...offered.collections,
    ...alsoOffer.filter((one) => !offered.collections.some((each) => each.id === one.id)),
  ];

  return (
    <>
      <Problem
        problem={
          offered.error === null
            ? null
            : problemOf(offered.error, "The Collections could not be read.")
        }
      />

      {offered.pending ? (
        <div className="grid gap-3" role="status" aria-label="Reading the Collections">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-6 w-48" />
        </div>
      ) : null}

      {/* Gated on the read having **succeeded** rather than on the list being empty, which is
          the rule the Fulfilment Strategy field already carries: until kobai has answered, this
          list is empty for want of an answer rather than because the Store has none. */}
      {offered.read && rows.length === 0 ? whenNone : null}

      {rows.length > 0 ? (
        <FieldSet>
          <FieldLegend variant="label">In these Collections</FieldLegend>
          {/* `checkbox-group` is what `Field`'s own spacing rules key off, so the list is
              spaced the way shadcn spaces a set of checkboxes. */}
          <FieldGroup data-slot="checkbox-group">
            {rows.map((collection) => (
              <Field key={collection.id} orientation="horizontal">
                <Checkbox
                  id={`${idPrefix}-${collection.id}`}
                  checked={chosen.includes(collection.id)}
                  onCheckedChange={(inIt) =>
                    field.onChange(
                      inIt
                        ? [...chosen, collection.id]
                        : chosen.filter((each) => each !== collection.id),
                    )
                  }
                />
                {/* A `<label for>` reaches the checkbox because Base UI's root is a
                    `<button>`, which is labelable — so clicking the title toggles it and a
                    screen reader announces the Collection as the control's name. */}
                <FieldLabel
                  htmlFor={`${idPrefix}-${collection.id}`}
                  className="font-normal"
                >
                  {collection.title}
                </FieldLabel>
              </Field>
            ))}
          </FieldGroup>
        </FieldSet>
      ) : null}
    </>
  );
}

/**
 * The field's value as the list of identifiers it is, whatever react-hook-form handed over.
 *
 * `useController` types its value as the form's own, which a caller could in principle have
 * declared as anything — so this is the one place the shape is settled, exactly as
 * `components/permissions-field.tsx` settles its own.
 */
function toIdentifiers(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}
