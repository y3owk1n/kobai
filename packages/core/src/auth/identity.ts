/**
 * The two shapes the admin surface reports a Merchant with — one type each, rather than the
 * same two fields written out at every place that returns them.
 *
 * They are the *outside* of a Merchant and a Role: what a sign-in answers with, what the
 * Admin renders, and what a generated client will carry. Neither carries a Store, because a
 * deployment is one Store and a scoping key is how multi-tenancy arrives (ADR-0005).
 */

/** A Merchant, named only by what identifies them. Never a digest. */
export type MerchantIdentity = {
  readonly id: string;
  readonly email: string;
};

/**
 * A Role and the permission set it carries (ADR-0027).
 *
 * `readonly string[]` rather than `Permission[]`: these come out of the database, where a
 * deployment may hold a Role naming a permission this build of Core has never heard of.
 */
export type RoleSummary = {
  readonly name: string;
  readonly permissions: readonly string[];
};
