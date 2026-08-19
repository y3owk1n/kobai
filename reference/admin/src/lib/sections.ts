import { KeyRoundIcon, PackageIcon, ReceiptTextIcon } from "lucide-react";

/**
 * What a Merchant switches between, as data rather than markup.
 *
 * A detail screen is reached from its list and gets no entry: `/products/{id}` belongs to
 * Products, which is what {@link sectionOf} answers.
 *
 * **There are two readers and there will be more**, which is why this is a module of its own
 * rather than a `const` in the layout that draws the sidebar. `components/app-layout.tsx`
 * draws one entry per section and `components/command-palette.tsx` offers one row per
 * section, and a list that lived in the first would have been copied into the second — which
 * is how a sidebar and a palette come to disagree about what this Admin has.
 *
 * **This is also the one place #178 filters.** Showing a Merchant only the sections their Role
 * can read is an affordance rather than a boundary (ADR-0063), and the shape it wants is a
 * narrowing of *this list*, once, rather than a permission check inside each entry the sidebar
 * draws and each row the palette offers. Nothing here is gated today and nothing here mentions
 * a Permission.
 */
export type Section = {
  /** The route this is, exactly as `app.tsx` spells it. */
  readonly path: string;
  readonly label: string;
  readonly Icon: typeof PackageIcon;
};

export const SECTIONS = [
  { path: "/products", label: "Products", Icon: PackageIcon },
  { path: "/orders", label: "Orders", Icon: ReceiptTextIcon },
  { path: "/api-keys", label: "API keys", Icon: KeyRoundIcon },
] as const satisfies readonly Section[];

/**
 * Which section a path belongs to, so a detail view keeps its list highlighted.
 *
 * **Matched at the `/` boundary and never by bare prefix.** `/products` is a bare string prefix
 * of a hypothetical `/products-archive`, which would then light up the wrong entry — the same
 * shape of mistake `/admin` being a prefix of `/admin-ui` already cost this repository once, and
 * the fix is the same one: compare against `${path}/`, so the match is a path and not a string.
 */
export function sectionOf(pathname: string): Section | undefined {
  return SECTIONS.find(
    (section) => pathname === section.path || pathname.startsWith(`${section.path}/`),
  );
}
