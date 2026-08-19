import { KeyRoundIcon, PackageIcon, ReceiptTextIcon } from "lucide-react";
import { PERMISSIONS, usePermissions } from "@/lib/permissions";

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
 * **This is also the one place the list is filtered** (#178). Showing a Merchant only the
 * sections their Role can read is an affordance rather than a boundary (ADR-0063), and the shape
 * it wants is a narrowing of *this list*, once — {@link useSections} — rather than a permission
 * check inside each entry the sidebar draws and each row the palette offers.
 */
export type Section = {
  /** The route this is, exactly as `app.tsx` spells it. */
  readonly path: string;
  readonly label: string;
  readonly Icon: typeof PackageIcon;
  /**
   * The Permission the list this section opens on is gated by, in Core.
   *
   * The **read**, always: what this decides is whether opening the section shows a Merchant
   * anything, and a Role that can change a thing it cannot read is not a shape kobai has —
   * every family on the admin surface splits read from write and `owner` holds both (ADR-0066).
   * What a Merchant may *do* once they are here is each screen's own question, asked through
   * `lib/permissions.ts`.
   */
  readonly permission: string;
};

export const SECTIONS = [
  {
    path: "/products",
    label: "Products",
    Icon: PackageIcon,
    permission: PERMISSIONS.catalogRead,
  },
  {
    path: "/orders",
    label: "Orders",
    Icon: ReceiptTextIcon,
    permission: PERMISSIONS.orderRead,
  },
  {
    path: "/api-keys",
    label: "API keys",
    Icon: KeyRoundIcon,
    permission: PERMISSIONS.apiKeyRead,
  },
] as const satisfies readonly Section[];

/**
 * The sections this Merchant's Role can read, in the order above.
 *
 * **An affordance and never a boundary** (ADR-0063): every route still exists and every one of
 * them is still gated by Core. What this decides is what a Merchant is *offered* — a section
 * that would refuse on load is left out because an empty screen that 403s teaches nothing,
 * where an individual action is shown and explained instead. `lib/permissions.ts` has the whole
 * of that reasoning, including why the set of Permissions is asked by membership.
 *
 * A hook rather than a function of a permission list, because there are **three** readers — the
 * sidebar, the palette, and the front door in `app.tsx` — and `sectionsFor(usePermissions())`
 * written out at each of them is the copy this module exists to prevent, one level along.
 *
 * A Role holding none of them gets `[]`, which is a real state — `POST /admin/roles` creates a
 * Role with no Permissions by default — and `app.tsx` is where it is answered with a screen
 * rather than an empty frame.
 */
export function useSections(): readonly Section[] {
  const permissions = usePermissions();
  return SECTIONS.filter((section) => permissions.includes(section.permission));
}

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
