import {
  ImageIcon,
  KeyRoundIcon,
  LayersIcon,
  PackageIcon,
  ReceiptTextIcon,
  ShieldCheckIcon,
  ShoppingCartIcon,
  StoreIcon,
  UsersIcon,
} from "lucide-react";
import { PERMISSIONS, usePermissions } from "@/lib/permissions";

/**
 * What the sections are grouped into, in the order the sidebar draws them (#266, ADR-0079).
 *
 * Three groups rather than six loose entries beside one nested one: a sidebar with two
 * organising principles reads as an afterthought, and it would make {@link Section.group} the
 * kind of optional field that is set once and stays set once forever. The order is the order —
 * `Commerce` first, because that is where a Merchant's day is and because the front door lands
 * on the head of this list, which was Products before this ticket and still is.
 *
 * A tuple rather than a set, because two readers want two different things from it: the sidebar
 * draws the groups in this order, and the type below closes the field so a section cannot be
 * authored into a group nothing draws.
 */
export const SECTION_GROUPS = ["Commerce", "Settings", "Developer"] as const;

/** One of the three, which is what every entry below carries. */
export type SectionGroup = (typeof SECTION_GROUPS)[number];

/**
 * What a Merchant switches between, as data rather than markup.
 *
 * A detail screen is reached from its list and gets no entry: `/products/{id}` belongs to
 * Products, which is what {@link sectionOf} answers.
 *
 * **There are two readers and there will be more**, which is why this is a module of its own
 * rather than a `const` in the layout that draws the sidebar. `components/app-layout.tsx`
 * draws one entry per section, in {@link SECTION_GROUPS}, and
 * `components/command-palette.tsx` offers one flat row per section, and a list that lived in
 * the first would have been copied into the second — which is how a sidebar and a palette come
 * to disagree about what this Admin has.
 *
 * **This is also the one place the list is filtered** (#178). Showing a Merchant only the
 * sections their Role can read is an affordance rather than a boundary (ADR-0063), and the shape
 * it wants is a narrowing of *this list*, once — {@link useSections} — rather than a permission
 * check inside each entry the sidebar draws and each row the palette offers.
 *
 * **And it is where each one's group lives** (#266, ADR-0079). The sidebar draws
 * {@link useGroupedSections}; the palette and the front door read the flat list, because a
 * palette that nests is a menu and a front door has one head.
 */
export type Section = {
  /** The route this is, exactly as `app.tsx` spells it. */
  readonly path: string;
  readonly label: string;
  readonly Icon: typeof PackageIcon;
  /**
   * Which group the sidebar draws this under.
   *
   * **Required, on every entry.** A group set on some of them would make the sidebar two
   * navigations — grouped and loose — and this the field that never reaches the next section
   * somebody adds (ADR-0079).
   */
  readonly group: SectionGroup;
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

/**
 * Every section this Admin has, written down once.
 *
 * Authored in group order, which is how it reads rather than what decides anything: the order a
 * Merchant meets — in the sidebar, in the palette and at the front door — comes from
 * {@link SECTION_GROUPS} and each group's own entries below. Adding a section means putting it
 * beside the ones sharing its group rather than at the end, which is exactly the choice #254 did
 * not have when it added Media to a flat list of seven.
 *
 * **Within a group the order is the one the entries already had**, and `Settings` is where that
 * is a decision rather than a coincidence (#266). The front door lands on the head of this list
 * once it is narrowed, so every entry that moves past another moves some Role's landing — and
 * `Merchants`, `Roles`, `Store` is the order those three were in before this ticket, which is
 * why a Role holding `merchant:read` and `store:read` still arrives at Merchants. Heading the
 * group with `Store` would have moved it for nothing grouping requires.
 *
 * **What could not be preserved is said plainly**: a Role whose head *was* API keys lands
 * somewhere else, because that screen is last now rather than fifth and moving it into
 * `Developer` is the whole of this ticket. Every Role kobai seeds holds `catalog:read` and so
 * still lands on Products, which is the clause ADR-0079 argues; the alternative was a palette
 * whose rows read in an order matching nothing on screen.
 */
export const SECTIONS = [
  {
    path: "/products",
    label: "Products",
    Icon: PackageIcon,
    permission: PERMISSIONS.catalogRead,
    group: "Commerce",
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
    group: "Commerce",
  },
  {
    /**
     * Beside Products and Media, because a Collection is catalog data too (#256, ADR-0074) and
     * `catalog:read` is what opens all three — the grouping is a catalog relationship, while the
     * *page* that renders a Collection is content and belongs to the Plugin. So it is
     * `Commerce`, and it is authored beside the two it shares a Permission with rather than at
     * the end of the group, which is what #266 asks of the next section added.
     *
     * A section of its own rather than a card on the Products screen, because a Collection is a
     * record a Merchant makes, renames and deletes, and it outlives every Product in it. Which
     * Products are in one is asked from the Products list, which narrows by `?collection=`.
     *
     * **It moves no Role's landing**, which is the thing to check before adding a section: the
     * front door heads the narrowed list, and every Role that can read Collections can read
     * Products, which is still ahead of it.
     */
    path: "/collections",
    label: "Collections",
    Icon: LayersIcon,
    permission: PERMISSIONS.catalogRead,
    group: "Commerce",
  },
  {
    path: "/orders",
    label: "Orders",
    Icon: ReceiptTextIcon,
    permission: PERMISSIONS.orderRead,
    group: "Commerce",
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
    group: "Commerce",
  },
  {
    path: "/merchants",
    label: "Merchants",
    Icon: UsersIcon,
    permission: PERMISSIONS.merchantRead,
    group: "Settings",
  },
  {
    path: "/roles",
    label: "Roles",
    Icon: ShieldCheckIcon,
    permission: PERMISSIONS.merchantRead,
    group: "Settings",
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
    group: "Settings",
  },
  {
    /**
     * **A Developer's screen, in the group it was always in** (ADR-0079).
     *
     * It mints `kobai_pk_…` and `kobai_sk_…` for a storefront and explains the prefix
     * convention to whoever ships the key; no part of it is about running a shop. It sat
     * between Carts and Merchants because a flat list had nowhere else to put it.
     *
     * **The address moved with it**, from `/api-keys`, and **no redirect was left behind**:
     * kobai is not published, so there is no bookmark to preserve, and a redirect would be
     * permanent furniture in vendored source `kobai-upgrade` can never reach (ADR-0035). The
     * Permission did not move — `api-key:read` is what opens this, in its new place as in its
     * old one.
     */
    path: "/developer/api-keys",
    label: "API keys",
    Icon: KeyRoundIcon,
    permission: PERMISSIONS.apiKeyRead,
    group: "Developer",
  },
] as const satisfies readonly Section[];

/** A group of the sidebar's, and what this Merchant's Role may read inside it. */
export type SectionsInGroup = {
  readonly group: SectionGroup;
  readonly sections: readonly Section[];
};

/**
 * What this Merchant's Role can read, in the groups the sidebar draws them in.
 *
 * **This is the narrowing, and there is one of it** (#178). An affordance and never a boundary
 * (ADR-0063): every route still exists and every one of them is still gated by Core. What this
 * decides is what a Merchant is *offered* — a section that would refuse on load is left out
 * because an empty screen that 403s teaches nothing, where an individual action is shown and
 * explained instead. `lib/permissions.ts` has the whole of that reasoning, including why the
 * set of Permissions is asked by membership.
 *
 * **An empty group is dropped rather than drawn empty.** A heading naming a category with
 * nothing under it reads as a list that failed to load — which is what the sidebar's single
 * group was `hidden` for before #266 — so a Role that may read only the Merchants roster meets
 * `Settings` alone, and a Role that may read nothing meets no heading whatever and is answered
 * with a screen in `app.tsx`.
 */
export function useGroupedSections(): readonly SectionsInGroup[] {
  const permissions = usePermissions();

  return SECTION_GROUPS.map((group) => ({
    group,
    sections: SECTIONS.filter(
      (section) => section.group === group && permissions.includes(section.permission),
    ),
  })).filter((inGroup) => inGroup.sections.length > 0);
}

/**
 * The same sections, flat: what the palette offers a row each, and what the front door heads.
 *
 * **The grouped list flattened, rather than a second filter over {@link SECTIONS}.** Both would
 * narrow identically today, and the difference is what happens to a section authored out of
 * group order: this way its palette row and its sidebar entry cannot end up in two different
 * places, because there is one order and the sidebar's is it. The narrowing itself happens
 * once, in {@link useGroupedSections}, which is the shape #178 asks for.
 *
 * A hook rather than a function of a permission list, because there are **three** readers — the
 * sidebar (grouped), the palette, and the front door in `app.tsx` — and
 * `sectionsFor(usePermissions())` written out at each of them is the copy this module exists to
 * prevent, one level along.
 *
 * A Role holding none of them gets `[]`, which is a real state — `POST /admin/roles` creates a
 * Role with no Permissions by default — and `app.tsx` is where it is answered with a screen
 * rather than an empty frame.
 */
export function useSections(): readonly Section[] {
  return useGroupedSections().flatMap((inGroup) => inGroup.sections);
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
