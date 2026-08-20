import {
  ImageIcon,
  KeyRoundIcon,
  PackageIcon,
  ReceiptTextIcon,
  ShieldCheckIcon,
  ShoppingCartIcon,
  StoreIcon,
  UsersIcon,
} from "lucide-react";
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
    /**
     * Beside Products, because Media is catalog data (ADR-0015) and `catalog:read` is what
     * opens it — the same Permission the Products list is behind. It is a section of its own
     * rather than a card on a Product because nothing attaches a Media to a Product yet: what
     * this Store has is a library, and the screen says so.
     */
    path: "/media",
    label: "Media",
    Icon: ImageIcon,
    permission: PERMISSIONS.catalogRead,
  },
  {
    path: "/orders",
    label: "Orders",
    Icon: ReceiptTextIcon,
    permission: PERMISSIONS.orderRead,
  },
  {
    /**
     * Beside Orders, because that is the pair a Merchant actually reasons about: a Cart is what
     * an Order was before it was bought, and the question this section answers — *why is that
     * stock unavailable?* — is asked while looking at what has and has not sold (ADR-0071).
     */
    path: "/carts",
    label: "Carts",
    Icon: ShoppingCartIcon,
    permission: PERMISSIONS.cartRead,
  },
  {
    path: "/api-keys",
    label: "API keys",
    Icon: KeyRoundIcon,
    permission: PERMISSIONS.apiKeyRead,
  },
  {
    path: "/merchants",
    label: "Merchants",
    Icon: UsersIcon,
    permission: PERMISSIONS.merchantRead,
  },
  {
    path: "/roles",
    label: "Roles",
    Icon: ShieldCheckIcon,
    permission: PERMISSIONS.merchantRead,
  },
  {
    /**
     * **Not `/store`, and that is a constraint of this repository rather than a preference.**
     *
     * `tests/admin-uses-only-the-public-api.test.ts` reads every quoted path anywhere in this
     * tree that begins with admin, store or health as a kobai path the published description
     * has to carry — which is how ADR-0010's promise is kept by the build instead of by
     * review, and it is strict enough to have caught the first draft of this very comment.
     * The Admin's own addresses live in a different namespace from kobai's (they are under
     * `/admin-ui`, and the router's `basename` is what puts them there), and a route spelled
     * `/store` would be indistinguishable from a claim about the API in a scan that can only
     * read strings. So the section a Merchant sees is called Store and the address it is at is
     * not one of kobai's — which is also what `/settings` reads as, since one deployment is one
     * Store (ADR-0005) and this screen is the whole of what a deployment can be configured to
     * be.
     */
    path: "/settings",
    label: "Store",
    Icon: StoreIcon,
    permission: PERMISSIONS.storeRead,
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
