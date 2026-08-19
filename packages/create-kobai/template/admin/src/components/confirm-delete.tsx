import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { ActionButton } from "@/components/action-button";
import { Problem } from "@/components/problem";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * A deletion confirmed, attempted, and — when kobai turns it back — explained where it was
 * attempted (ADR-0059, ADR-0063).
 *
 * **The refusal is the reason this is a component rather than three lines per caller.**
 * Catalog deletion refuses rather than cascading: `last-variant` because a Product with no
 * Variant is a state ADR-0008 spends a row to prevent, and `stock-is-reserved` because units
 * claimed by an Order being placed are not the deleter's to take away. So a delete control
 * that looks perfectly available can still come back refused, and the Merchant is standing in
 * a modal when it does.
 *
 * What that costs, and what this gets right so that four callers cannot each get it wrong:
 *
 * - **The dialog stays open on a refusal, and the reason renders inside it.** Closing it and
 *   putting the explanation on the page underneath puts the words where the Merchant no longer
 *   is — and, worse, the thing they were looking at is still there, so the screen reads as
 *   though nothing happened at all.
 * - **Nothing is predicted.** There is no `canDelete` prop and there must not be one: whether
 *   stock is reserved is a rule that lives in Core, that Core may change, and that a
 *   Developer's Project may already have changed through a replaced Step. The Admin submits
 *   and renders the answer.
 * - **The refusal is cleared when the dialog is reopened**, not when it closes: a Merchant who
 *   cancels and comes back is asking again, and a stale explanation from the previous attempt
 *   would read as the answer to the new one.
 * - **Only success closes it.** `onDeleted` runs after that, which is where a caller
 *   invalidates a query or navigates away from an address that no longer resolves.
 *
 * `unavailable` is `useUnavailable`'s sentence, handed straight through to
 * {@link ActionButton} — so a Role without `catalog:write` sees the trigger, cannot open it,
 * and is told why. None of that is a boundary; `requirePermission` in Core is.
 */
export function ConfirmDelete({
  trigger,
  title,
  description,
  confirm,
  unavailable,
  onDelete,
  onDeleted,
  problemOf,
}: {
  /** What the button on the screen says — "Delete Product", "Remove". */
  readonly trigger: string;
  /** The question the dialog asks, as a question. */
  readonly title: string;
  /** What is about to happen, and what it cannot be undone by. */
  readonly description: ReactNode;
  /** What the button that does it says. Defaults to {@link trigger}. */
  readonly confirm?: string;
  /** Why this Merchant cannot, or `null` when they can. */
  readonly unavailable: string | null;
  /** The call itself. Rejecting keeps the dialog open. */
  readonly onDelete: () => Promise<unknown>;
  /** Run once it worked, after the dialog has closed. */
  readonly onDeleted?: () => void;
  /** kobai's refusal, in words this screen can offer. */
  readonly problemOf: (thrown: unknown) => string;
}) {
  const [open, setOpen] = useState(false);

  const remove = useMutation({
    mutationFn: onDelete,
    onSuccess: () => {
      setOpen(false);
      onDeleted?.();
    },
  });

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Reset on the way *in* rather than on the way out: a refusal from the previous
        // attempt must not be on screen when the question is asked again, and clearing it as
        // the dialog closes would wipe the explanation out from under the Merchant reading it.
        if (next) remove.reset();
        setOpen(next);
      }}
    >
      {/* Not `AlertDialogTrigger`: an unavailable action is `aria-disabled` rather than
          `disabled`, so it stays focusable and can host the sentence explaining itself — and a
          trigger that opened the dialog anyway would offer a Merchant a confirmation for
          something kobai is about to refuse at the gate. `ActionButton`'s no-op is what makes
          "unavailable" true rather than decorative. */}
      <ActionButton
        variant="outline"
        size="sm"
        unavailable={unavailable}
        onClick={() => setOpen(true)}
      >
        {trigger}
      </ActionButton>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {/* Inside the dialog, and this is the whole point of the component: a refused deletion
            is answered where it was attempted (ADR-0059). */}
        <Problem
          title="kobai would not delete it."
          problem={remove.isError ? problemOf(remove.error) : null}
        />

        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          {/* A plain `Button` under `AlertDialogAction`, so activating it does not close the
              dialog: whether this closes is the mutation's answer and not the click's. */}
          <AlertDialogAction
            render={<Button variant="destructive" />}
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? <Spinner /> : null}
            {confirm ?? trigger}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
