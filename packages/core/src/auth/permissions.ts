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
  /**
   * Administer access — add a Merchant, and make, change or delete the Roles one is added
   * against.
   *
   * One Permission for all of it, because it is one power: a Merchant who may add a colleague
   * may add one against `owner` and sign in as them, so a `role:write` beside this would draw
   * a boundary that does not exist (ADR-0066). What it does *not* reach is seeing who has
   * access, which is `merchantRead` below.
   */
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
  /**
   * Change the Store — its name and its metadata.
   *
   * Its own permission rather than a second use of `store:read`, on the split every other pair
   * on this surface already draws: `catalog:read` is not `catalog:write` and `api-key:read` is
   * not `api-key:write`, because seeing what a deployment is and changing it are different
   * powers. Which gate a route sits behind is promised surface (ADR-0060), so gating a write
   * behind the read permission would have been a break to undo rather than a decision to take.
   *
   * It reads oddly last, beside `api-key:read`, and belongs there for the same reason: the
   * seeded `owner` Role is a text array appended to one migration at a time, and a test
   * asserts it equals `ALL_PERMISSIONS` exactly — so this list's order is the order the
   * migrations ran, and a new permission goes at the end.
   */
  storeWrite: "store:write",
  /**
   * See who has access — the Merchants of this deployment, and the Roles they may be given.
   *
   * The half of administering access that `merchant:write`'s transitive argument does not
   * reach (ADR-0066). Adding a colleague confers everything, because the colleague can be
   * added against `owner`; reading the roster confers nothing, and without a word for it the
   * only way to let somebody see who has access would be to give them the power to change it.
   * Every other pair on this surface already splits the same way — `catalog:`, `api-key:`,
   * `store:` — and which gate a route sits behind is promised (ADR-0060), so this is a
   * decision to take now rather than a break to undo later.
   *
   * It reads oddly last, after the write it belongs beside, for the same reason `api-key:read`
   * and `store:write` do: the seeded `owner` Role is a text array appended to one migration at
   * a time and a test asserts it equals `ALL_PERMISSIONS` exactly, so this list's order is the
   * order the migrations ran.
   */
  merchantRead: "merchant:read",
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
