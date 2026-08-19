import { createContext, type ReactNode, use, useEffect } from "react";

/**
 * What a detail screen calls the record it is showing, for the breadcrumb above it.
 *
 * The breadcrumb is derived from the URL and from nothing else (`components/app-layout.tsx`),
 * which is right for a section and wrong for a record: `/orders/8f3c…` reads as a UUID in the
 * one place a Merchant looks to find out where they are. The title is not something the layout
 * can know — `GET /admin/orders/{id}` is what knows it, and a layout that fetched one would be
 * fetching it a second time on every screen that already has it.
 *
 * So the screen tells the frame, and it flows **up** rather than down: a context whose value is
 * a setter, written to in an effect and cleared on the way out. `null` is the honest state
 * before the record arrives — the crumb falls back to the identifier from the URL, which is
 * what it has always shown — rather than an empty crumb that would make the breadcrumb flicker
 * shorter and back.
 *
 * It is deliberately not the document title, not a heading and not a route `handle`. A `handle`
 * would need react-router's data router, which ADR-0063's `<BrowserRouter>` is not; a heading
 * is already the screen's own `h2`.
 */
const CrumbContext = createContext<((label: string | null) => void) | null>(null);

/**
 * Lets the screens under this name their record.
 *
 * The layout owns the state and passes the setter down here, so the crumb it renders and the
 * setter a screen calls are two halves of one `useState` rather than two sources.
 */
export function CrumbProvider({
  name,
  children,
}: {
  readonly name: (label: string | null) => void;
  readonly children: ReactNode;
}) {
  return <CrumbContext value={name}>{children}</CrumbContext>;
}

/**
 * Names this screen's record in the breadcrumb, for as long as the screen is on it.
 *
 * `undefined` while the record is being read, which leaves the crumb as it was; the cleanup is
 * what clears it, so walking from a Product back to the list does not leave the Product's title
 * over the list's own crumb.
 *
 * Calling it outside the layout is a no-op rather than a throw: the sign-in screen and the boot
 * gate render in place of the frame, and a screen that is sometimes inside it should not have
 * to know which.
 */
export function useCrumbTitle(label: string | undefined): void {
  const name = use(CrumbContext);

  useEffect(() => {
    if (!name) return undefined;
    name(label ?? null);
    return () => name(null);
  }, [name, label]);
}
