import type { ComponentProps } from "react";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * One field of a form: a label, an input, and whatever the schema said about it.
 *
 * Three forms in this Admin were the same eight lines each — New Product, sign in, mint a key —
 * and every one of them had to remember the same two things, which is exactly the shape a
 * component is for. `Field` and `FieldError` are shadcn's; this composes them and decides
 * nothing about how they look (ADR-0063).
 *
 * The two things worth remembering, and the reason this exists rather than a comment:
 *
 * - **The invalid state is set twice, because two things read it.** `Field` colours itself from
 *   `data-invalid` and the `Input` announces itself to a screen reader with `aria-invalid`.
 * - **The `id` is unique to the document, not to the form.** Two forms on one screen each with
 *   a "Name" field would otherwise point both labels at whichever input rendered last, so a
 *   caller passes an `id` carrying its form's name as well as the field's.
 *
 * The caller spreads `form.register(name)` in itself rather than handing over the whole form
 * object. That keeps this free of react-hook-form's generics — which differ per form, and
 * differ again where a zod `transform` makes the input and output types diverge — and it keeps
 * the registration visible at the field it registers.
 */
export function FormField({
  id,
  label,
  error,
  ...input
}: {
  readonly id: string;
  readonly label: string;
  /** react-hook-form's error object for this field, as it comes. */
  readonly error: { readonly message?: string } | undefined;
  // `form` is HTML's own attribute on an `<input>` as well as react-hook-form's object, and an
  // input inside a `<form>` needs no such attribute — so it is refused here rather than left to
  // collide.
} & Omit<ComponentProps<typeof Input>, "id" | "form">) {
  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} aria-invalid={error !== undefined} {...input} />
      <FieldError errors={[error]} />
    </Field>
  );
}
