import { createContext, type ReactNode, type RefObject, use } from "react";

/**
 * Where a popup that is portaled out of its screen should land.
 *
 * **A portal's default target is `<body>`, and that is outside every landmark.** Base UI moves a
 * `Select`'s list, a `DropdownMenu`'s items and a `Tooltip`'s popup to the end of the document
 * so they escape the `overflow` and stacking contexts of whatever card they were opened from —
 * which is the right thing to do about clipping and the wrong place to leave *content*.
 * `axe-core` says so, as `region`: "all page content should be contained by landmarks". It is
 * the one accessibility failure in this Admin that only appears **while an overlay is open**,
 * which is exactly the state `tests/the-admin-in-a-browser.test.ts` audits.
 *
 * So the frame offers a container of its own, inside the `main` landmark, and the components
 * that portal render into it. Nothing about the escaping is given up: the popup is still
 * positioned `fixed` by floating-ui and still leaves its card's stacking context — it simply
 * lands somewhere the document's outline accounts for.
 *
 * **A dialog needs none of this and deliberately does not use it.** `axe` excludes a
 * `role="dialog"` or `role="alertdialog"` subtree from the region rule, because a modal is not
 * part of the page's landmark structure while it is up — so `ui/dialog.tsx` and
 * `ui/alert-dialog.tsx` portal to `<body>` as upstream wrote them, and were already green.
 *
 * The value is a **ref** rather than an element because the container is rendered by the layout
 * in the same pass that provides it: an element read during that render is `null`, and Base UI
 * re-reads a ref when the popup actually mounts, which is always later.
 */
const PortalContainerContext = createContext<RefObject<HTMLElement | null> | null>(null);

export function PortalContainerProvider({
  container,
  children,
}: {
  readonly container: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
}) {
  return <PortalContainerContext value={container}>{children}</PortalContainerContext>;
}

/**
 * The frame's portal container, or `undefined` where there is no frame.
 *
 * `undefined` rather than `null`, so it can be handed straight to Base UI's `container` prop and
 * mean "you decide" — which is `<body>`, and which is correct for the two screens that render
 * *in place of* the layout: the sign-in form and the boot gate have no `main` of their own to
 * land in, and neither has anything that portals.
 */
export function usePortalContainer(): RefObject<HTMLElement | null> | undefined {
  return use(PortalContainerContext) ?? undefined;
}
