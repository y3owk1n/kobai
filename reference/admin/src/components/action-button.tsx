import type { ComponentProps, MouseEvent } from "react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A `Button` that can be unavailable to this Merchant, and says why (ADR-0063, #178).
 *
 * Given no `unavailable` it is a `Button` and nothing else, so a screen may reach for this
 * wherever an action *might* be gated without branching on it. Given one, the whole of the
 * decision is here: the control stays on screen, stays focusable, carries the sentence, and
 * does nothing.
 *
 * **`aria-disabled` rather than `disabled`, and that is not a style preference.** A truly
 * `disabled` element fires no pointer events and takes no focus, so it can host no tooltip and
 * **cannot be reached to be told why** — the explanation this exists to give is unreachable
 * through the obvious implementation of it. The price of `aria-disabled` is the other half:
 * unlike `disabled` it does not prevent activation, so **the handler has to genuinely no-op**,
 * which is what the swallowed `onClick` below is. `tests/the-admin-in-a-browser.test.ts`
 * watches both halves — the keyboard reaches it and is told, and activating it makes no request
 * at all — and it was watched failing with that handler forwarded.
 *
 * **A form around one of these needs nothing of its own, and that was checked rather than
 * assumed.** Pressing Enter in a text field submits a form implicitly, which looks like a way
 * past a button that was never clicked — but the browser performs implicit submission *by
 * clicking the form's default button*, so it arrives here like any other activation and the
 * `preventDefault` below is what stops it. A second guard on the `<form>` was written first,
 * and taking it out again changed nothing any case could see.
 *
 * **None of this is a boundary.** `requirePermission` in Core is; see `lib/permissions.ts`.
 *
 * `disabled` is still the right answer elsewhere and is deliberately left alone: a control dead
 * because a request is in flight has nothing to explain and nothing to be told, which is why
 * every mutation here still passes `disabled={…isPending}` and why `Pager`'s dead Next and
 * Previous are really disabled.
 */
export function ActionButton({
  unavailable,
  onClick,
  className,
  children,
  ...button
}: ComponentProps<typeof Button> & {
  /** Why this Merchant cannot do it, or `null`/absent when they can. */
  readonly unavailable?: string | null;
}) {
  /**
   * What the sentence is called, so the control can point at it.
   *
   * Base UI's `Tooltip` in this distribution gives its popup no `role="tooltip"` and sets no
   * `aria-describedby` on the trigger — checked in the installed package rather than assumed —
   * so the tooltip is a **visual** affordance and nothing more. A Merchant reading this screen
   * with a screen reader would hear a button that is unavailable and no reason, which is the
   * one thing this component exists to prevent. So the sentence is also rendered where only a
   * screen reader finds it, and the control is described by it whether the tooltip is open or
   * not.
   */
  const reason = useId();

  if (unavailable === null || unavailable === undefined) {
    return (
      <Button className={className} onClick={onClick} {...button}>
        {children}
      </Button>
    );
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              {...button}
              aria-disabled
              aria-describedby={reason}
              // After the spread and not before it: a screen that passes both — `disabled`
              // for a request in flight and `unavailable` for the Role — must not get a
              // control that cannot be focused, which is the one thing this branch exists to
              // avoid. Nothing is in flight for a Merchant who cannot start it anyway.
              disabled={false}
              // The button's own `disabled:` classes cannot fire — nothing here is disabled —
              // and `pointer-events-none` is exactly what must *not* be set: a control that
              // cannot be hovered cannot show the tooltip explaining itself.
              className={cn("aria-disabled:opacity-50", className)}
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                // The no-op, for real: the caller's own handler is not forwarded at all, and
                // `preventDefault` is what a `type="submit"` needs on top of that — without it
                // the click still submits the form around it, which is also how a browser
                // performs the implicit submission of Enter in a field.
                event.preventDefault();
              }}
            >
              {children}
            </Button>
          }
        />
        {/* Hidden from the accessibility tree on purpose: this is the **visual** half, and
            the sentence is already announced through `aria-describedby` below. Left exposed it
            would be read twice — and it is content in a portal at the end of `<body>`, outside
            every landmark, which axe reports as `region` (Base UI gives its popup no
            `role="tooltip"` to be excused by, and a tooltip role would not excuse it anyway).
            The popup holds no focusable content, so nothing is being hidden from a keyboard. */}
        <TooltipContent aria-hidden>{unavailable}</TooltipContent>
      </Tooltip>
      {/* Outside the button rather than inside it: a child of the control would become part of
          its accessible **name**, so it would be announced as "Create Your Role cannot…"
          instead of as a button with a description. `sr-only` is absolutely positioned, so this
          is not a flex item and adds no gap to the toolbar or footer it sits in. */}
      <span id={reason} className="sr-only">
        {unavailable}
      </span>
    </>
  );
}
