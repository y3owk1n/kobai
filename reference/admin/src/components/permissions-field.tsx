import { PlusIcon } from "lucide-react";
import { type KeyboardEvent, useMemo, useState } from "react";
import {
  type Control,
  type FieldValues,
  type Path,
  useController,
} from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useOfferedPermissions } from "@/lib/permissions";

/**
 * What a Role may do, as a set of strings a Merchant can add to and take away from.
 *
 * **The set of Permissions is open, and this field is the one place in the Admin where that
 * stops being a footnote** (#173, ADR-0066). `POST /admin/roles` stores any non-empty string
 * and answers it back unchanged, because a Plugin's Permission must be sayable without a
 * release of Core — `Session`'s own description promises a deployment "may hold a permission
 * this build of Core has never heard of". So there are two halves here and neither is
 * decoration:
 *
 * - **A word Core does not know is shown, ticked, and survives a save.** Every Permission the
 *   Role currently holds is offered whether or not this Admin has ever seen it, which is
 *   `useOfferedPermissions`' job. An editor that quietly dropped one would put the Role back
 *   *missing* it on the next save — data loss spelled as a form, and the failure this
 *   acceptance criterion exists to prevent.
 * - **A word nobody holds yet can still be typed.** The suggestions are built from what kobai
 *   has already said in this deployment, so they cannot contain a Permission that has never
 *   been granted anywhere. That is exactly the case of a Plugin shipping one, so the field
 *   below is not a convenience — it is the only way that Permission is ever reachable.
 *
 * **Nothing here validates a Permission**, and there is no list of Core's own to validate
 * against (ADR-0063's rule: a rule that lives in Core is not re-implemented in a browser, and
 * a vocabulary the API deliberately leaves open is not closed here). The only thing refused is
 * a blank, which is the field being non-empty rather than a claim about what kobai accepts.
 *
 * It is driven through `useController` rather than a `useState` beside the form, for the same
 * reason `FulfilmentStrategyField` is: the value is not an `<input>`'s, so it cannot be
 * `register`ed, and the form still has to own it or `formState.errors` and `reset` stop
 * working for this field alone.
 */
export function PermissionsField<T extends FieldValues>({
  id,
  control,
  name,
}: {
  readonly id: string;
  readonly control: Control<T>;
  readonly name: Path<T>;
}) {
  const { field, fieldState } = useController({ control, name });
  const held = toPermissions(field.value);
  const suggested = useOfferedPermissions(held);
  const [typed, setTyped] = useState("");

  /**
   * Every Permission this field has offered, whether or not the Role still holds it.
   *
   * **Unticking one must not take it off the screen**, and it would: a word Core has never
   * heard of is offered *because the Role holds it*, so the moment it is unticked it stops
   * being suggested and its checkbox vanishes — leaving a Merchant who mis-clicked with no way
   * back except to remember the word and retype it. So the list only ever grows while the
   * field is mounted, and a save is what settles what the Role actually holds.
   */
  const [everOffered, setEverOffered] = useState<readonly string[]>(() => suggested);
  const offered = useMemo(
    () => [...new Set([...everOffered, ...suggested])].sort(),
    [everOffered, suggested],
  );

  const set = (permissions: readonly string[]) => {
    field.onChange([...permissions]);
  };

  const toggle = (permission: string, holds: boolean) => {
    set(
      holds ? [...held, permission] : held.filter((existing) => existing !== permission),
    );
  };

  /**
   * Adds whatever is in the box, and does nothing at all with a blank or a duplicate.
   *
   * Trimmed because a Permission with a space around it is a *different* string as far as
   * kobai is concerned, and a Merchant who pasted one would get a Role holding a word that
   * matches nothing and refuses nothing.
   */
  const add = () => {
    const permission = typed.trim();
    if (permission === "" || held.includes(permission)) {
      setTyped("");
      return;
    }
    set([...held, permission]);
    // Remembered as well as ticked, so unticking it does not lose the word that was typed.
    setEverOffered((was) => [...new Set([...was, permission])]);
    setTyped("");
  };

  /**
   * Enter in the box adds a Permission rather than submitting the form around it.
   *
   * This cannot be a `<form>` of its own — a form inside a form is not something a browser
   * will parse — so the outer form's implicit submission is what Enter would otherwise reach,
   * and a Merchant who typed a Permission and pressed Enter would save the Role *without* it.
   * `preventDefault` is what stops that, and it is the whole reason this handler exists.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    add();
  };

  return (
    <FieldSet data-invalid={fieldState.error !== undefined}>
      <FieldLegend variant="label">Permissions</FieldLegend>
      <FieldDescription>
        What a Merchant holding this Role may do. kobai checks that each is a non-empty
        string and nothing more, so a Permission a Plugin defines is a word like any
        other.
      </FieldDescription>

      {/* `checkbox-group` is what `Field`'s own spacing rules key off, so the list is spaced
          the way shadcn spaces a set of checkboxes rather than the way it spaces text fields. */}
      <FieldGroup data-slot="checkbox-group">
        {offered.map((permission) => (
          <Field key={permission} orientation="horizontal">
            <Checkbox
              id={`${id}-${permission}`}
              checked={held.includes(permission)}
              onCheckedChange={(holds) => toggle(permission, holds)}
            />
            {/* A `<label for>` reaches the checkbox because Base UI's root is a `<button>`,
                which is labelable — so clicking the word toggles it and a screen reader
                announces the Permission as the control's name. */}
            <FieldLabel htmlFor={`${id}-${permission}`} className="font-normal">
              <code>{permission}</code>
            </FieldLabel>
          </Field>
        ))}
      </FieldGroup>

      <div className="grid items-end gap-2 sm:grid-cols-[1fr_auto]">
        <Field>
          <FieldLabel htmlFor={`${id}-add`}>Add another Permission</FieldLabel>
          <Input
            id={`${id}-add`}
            value={typed}
            placeholder="reports:read"
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <FieldDescription>
            The list above is what this deployment already uses. A Permission nobody holds
            yet — a Plugin's, on the day it ships — is typed here.
          </FieldDescription>
        </Field>
        {/* `type="button"`, deliberately: an unmarked button inside a form is a submit button,
            so this would save the Role instead of adding the word. */}
        <Button type="button" variant="outline" onClick={add}>
          <PlusIcon />
          Add
        </Button>
      </div>

      <FieldError errors={[fieldState.error]} />
    </FieldSet>
  );
}

/**
 * The field's value as the list of strings it is, whatever react-hook-form handed over.
 *
 * `useController` types its value as the form's own, which a caller could in principle have
 * declared as anything — so this is the one place the shape is settled, rather than at each of
 * the four reads above.
 */
function toPermissions(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}
