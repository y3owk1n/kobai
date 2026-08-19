import type { ComponentProps, ReactNode } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

/**
 * One field of a form whose value is long enough to want a box: a label, a `Textarea`,
 * whatever the field needs explaining about it, and whatever the schema said about it.
 *
 * **`components/form-field.tsx`'s sibling, and the reason there are two rather than one** is
 * that `FormField` renders an `Input` and the two controls do not take the same props — a
 * `rows` an `Input` has never heard of, against an `Input`'s `type`. A discriminated `FormField`
 * would have to carry both sets and pick one, which is a wider surface than the one thing that
 * actually differs between them. **What is shared is the pair of things every field in this
 * Admin has to remember**, and they are the two `FormField`'s own header names:
 *
 * - **The invalid state is set twice, because two things read it.** `Field` colours itself from
 *   `data-invalid` and the control announces itself to a screen reader with `aria-invalid`.
 * - **The `id` is unique to the document, not to the form**, so a caller passes one carrying
 *   its form's name as well as the field's.
 *
 * It exists because the second copy had been written (#250): the Store's metadata box and the
 * Product's description box composed the same five elements by hand, and a third would have got
 * to forget either half of the invalid state with nothing going red — which is the history
 * `components/listbox-field.tsx` records for the vendored `Select` (#245).
 *
 * `description` is a `ReactNode` rather than a string because these sentences are the ones that
 * cite an ADR or emphasise a word, and it is optional because a field whose label says it all
 * needs none. The caller spreads `form.register(name)` in itself, exactly as `FormField`'s does
 * and for the same reason: it keeps this free of react-hook-form's per-form generics.
 */
export function TextareaField({
  id,
  label,
  error,
  description,
  ...textarea
}: {
  readonly id: string;
  readonly label: string;
  /** react-hook-form's error object for this field, as it comes. */
  readonly error: { readonly message?: string } | undefined;
  /** What this field needs explaining about it, under the box. */
  readonly description?: ReactNode;
  // `form` is HTML's own attribute on a `<textarea>` as well as react-hook-form's object, and a
  // control inside a `<form>` needs no such attribute — so it is refused here rather than left
  // to collide.
} & Omit<ComponentProps<typeof Textarea>, "id" | "form">) {
  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea id={id} aria-invalid={error !== undefined} {...textarea} />
      {description === undefined ? null : (
        <FieldDescription>{description}</FieldDescription>
      )}
      <FieldError errors={[error]} />
    </Field>
  );
}
