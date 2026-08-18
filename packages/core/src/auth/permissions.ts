/**
 * What a Role may hold, and what a route may ask for.
 *
 * A permission is a plain string in a set on the Role (ADR-0027). A route names **one** of
 * them and the gate answers once, before the handler runs — it never walks the resources the
 * handler is about to touch. That is the distinction ADR-0027 draws: named roles carrying
 * permission sets, not per-resource ACLs.
 *
 * The list is short because it only names permissions that gate something that exists. A
 * permission with no route behind it is a promise nobody has kept, so catalog permissions
 * arrive with the catalog rather than in anticipation of it.
 */
export const PERMISSIONS = {
  /** Read the Store. */
  storeRead: "store:read",
  /** Create a Merchant. The permission that makes a deployment able to grow a team. */
  merchantWrite: "merchant:write",
  /** Read the catalog — Products, their Variants, and those Variants' Prices. */
  catalogRead: "catalog:read",
  /** Change the catalog: create a Product with its Variants, price a Variant. */
  catalogWrite: "catalog:write",
  /** Mint and revoke API keys. The permission that hands out access to the store surface. */
  apiKeyWrite: "api-key:write",
  /**
   * List the API keys this deployment has issued — never their values, which are gone.
   *
   * It reads oddly after the write permission and belongs there anyway: the seeded `owner`
   * Role is a text array built by appending one migration at a time, and a test asserts it
   * equals `ALL_PERMISSIONS` exactly. So this list's order is the order the migrations ran,
   * and a new permission goes at the end wherever it would read best.
   */
  apiKeyRead: "api-key:read",
  /**
   * Read the Orders this Store has taken — the list, and one opened.
   *
   * Its own permission rather than a second use of `catalog:read`, because the books and the
   * catalog are different powers: a colleague who maintains Products has no business reading
   * what every Shopper paid and who they are. There is no `order:write` beside it and there
   * never will be from here — an Order is immutable (ADR-0009), so there is nothing on this
   * surface for one to gate.
   */
  orderRead: "order:read",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * Every permission Core defines — what the seeded `owner` Role holds.
 *
 * A later Core version that adds a permission also adds it to `owner` in a migration.
 * Existing deployments therefore keep working, and a Role that is *not* `owner` gains
 * nothing it was not given.
 */
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

/** The Role a deployment's first Merchant is created against. Seeded by Core's migrations. */
export const OWNER_ROLE = "owner";
