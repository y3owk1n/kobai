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
  /**
   * See the Carts this Store is holding — the list, and one opened.
   *
   * Its own word rather than a second use of `order:read`, and the difference is the expensive
   * kind to get wrong (ADR-0071): ADR-0009's first decision is that a Cart and an Order are
   * governed by opposite rules — one is expected to change and be thrown away, the other must
   * never change again — so merging their Permissions would say the opposite in the one place a
   * deployment configures trust. `catalog:read` was the other candidate and is worse: a Role
   * granted so somebody could edit Products would silently include every Shopper's basket.
   *
   * There is no `cart:write` beside it **yet**, and the two halves of that are different:
   * creating and editing a Cart on a Merchant's behalf is decided (ADR-0071) and belongs to its
   * own spec, which will bring the word with it; **releasing a hold never arrives at all**,
   * because doing it by hand takes stock from a Shopper who may be mid-payment at their bank and
   * the sweeper already releases on expiry.
   *
   * It reads oddly last, like the three above it, and belongs there for the same reason: the
   * seeded `owner` Role is a text array appended to one migration at a time and a test asserts
   * it equals `ALL_PERMISSIONS` exactly, so this list's order is the order the migrations ran.
   */
  cartRead: "cart:read",
  /**
   * Read what this deployment *is* — the version of Core it runs, the Steps filling each
   * Workflow's positions, whether a Payment Provider is wired, and the OpenAPI description of
   * the surface it serves (ADR-0080).
   *
   * **There is no `deployment:write` beside it and there will not be one from here.**
   * Everything behind this word is decided by a file a Developer edits and a process restart,
   * so there is nothing on this surface for a write to gate. That makes it the second
   * Permission with one half, beside `order:read`, and for the same kind of reason: an Order is
   * immutable, and a deployment's shape is not the API's to change.
   *
   * Its own word rather than a second use of `store:read`, on the split every other pair here
   * draws. A Store is the commercial identity — its name, its metadata, its currency — and a
   * Role granted that so somebody could correct one would otherwise silently also see which
   * Steps this deployment has replaced. Which gate a route sits behind is promised surface
   * (ADR-0060), so that is a decision to take now rather than a break to undo later.
   *
   * It reads oddly last, like the four above it, and belongs there for the same reason: the
   * seeded `owner` Role is a text array appended to one migration at a time and a test asserts
   * it equals `ALL_PERMISSIONS` exactly, so this list's order is the order the migrations ran.
   */
  deploymentRead: "deployment:read",
  /**
   * Move a Fulfilment — dispatch one, mark one delivered, cancel one that cannot be (#320).
   *
   * **Its own word so that warehouse staff can dispatch and do nothing else** (story 16), which
   * is the whole of why it is not a second use of `order:read`: reading what every Shopper paid
   * and posting a parcel are different powers, and the person doing the second usually should
   * not have the first.
   *
   * **There is no `fulfilment:read` beside it**, and that absence is a decision rather than an
   * asymmetry. A Fulfilment is not addressable on its own — it is read *through* its Order, on
   * the shape `GET /admin/orders/{id}` and `GET /store/orders/{id}` already answer with — so
   * there is no route for one to gate, and the house rule adds a Permission when a route needs
   * one rather than for symmetry (`order:read` already covers it). The pair `catalog:` and
   * `store:` draw is between reading a thing and changing it; here the thing is read as part of
   * something else.
   *
   * It reads oddly last, like the five above it, and belongs there for the same reason: the
   * seeded `owner` Role is a text array appended to one migration at a time and a test asserts
   * it equals `ALL_PERMISSIONS` exactly, so this list's order is the order the migrations ran.
   */
  fulfilmentWrite: "fulfilment:write",
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
