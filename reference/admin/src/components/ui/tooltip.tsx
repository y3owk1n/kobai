import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { cn } from "@/lib/utils";

/**
 * **This tooltip is announced as nothing, and that is recorded rather than fixed** (#199,
 * ADR-0063).
 *
 * Base UI's tooltip at the version this Admin pins gives its popup **no `role="tooltip"`** and
 * sets **no `aria-describedby`** on the trigger — checked in the installed package rather than
 * assumed. So what is written in here is a **visual** affordance and nothing else: a Merchant
 * reading the screen with a screen reader focuses the control and hears the control, with no
 * hint that there was ever a sentence beside it.
 *
 * **So never put information only in one.** `components/action-button.tsx` is the shape to
 * copy for anything that must actually be announced: it renders the sentence a second time in
 * an `sr-only` span, points the control's `aria-describedby` at *that*, and marks this popup
 * `aria-hidden` so the same words are not read twice — and so the popup, which portals to the
 * end of `<body>` outside every landmark, is not content `axe-core` reports under `region`.
 *
 * Fixing the primitive was weighed and refused, and the reason is worth having before somebody
 * weighs it again. A `role` and an `aria-describedby` here would be honest but would not
 * replace that workaround: Base UI unmounts the popup when it is closed, so the description
 * would resolve to nothing until the tooltip is opened — which is precisely the reader who
 * never opens it. It would also make the popup announced content at `<body>`, so it would drag
 * in the container plumbing `select.tsx` and `dropdown-menu.tsx` carry, and
 * `shadcn add tooltip --overwrite` would take the lot away again in silence. The gap is cheap
 * to state and expensive to half-fix.
 *
 * Nothing depends on this today: the sidebar's collapsed tooltip is a nicety, because
 * `SidebarMenuButton` clips its label with `overflow-hidden` rather than removing it, so the
 * accessible name survives the collapse.
 *
 * **CHANGED FROM UPSTREAM: this comment, and nothing else.** The component itself is exactly
 * what `shadcn add` wrote, which is why `README.md` files it under its own heading rather than
 * in the list of changes to what a component *does*. It is still a departure an
 * `--overwrite` would delete, so `tests/an-unavailable-control-can-still-be-reached.test.ts`
 * asks for this note by name — a record nothing holds is what that file exists to replace.
 */
function TooltipProvider({ delay = 0, ...props }: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />
  );
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
