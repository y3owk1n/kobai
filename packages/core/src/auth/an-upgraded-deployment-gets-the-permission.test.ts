import { describe, expect, it } from "vitest";
import { coreMigrationSet, runMigrations } from "../migrations/index.ts";
import { createTestKobai, migrationSetUpTo, type TestKobai } from "../testing/index.ts";
import { ALL_PERMISSIONS, PERMISSIONS } from "./permissions.ts";

/**
 * `deployment:read` reaching the `owner` Role of a deployment that **already existed** — which
 * is the only state the migration that appends it ever meets in the field, and the one no other
 * test of Core's set arranges.
 *
 * `auth.test.ts` already holds the seeded `owner` Role equal to `ALL_PERMISSIONS`, and that
 * covers a deployment created *after* the permission was defined: its whole set applies at once
 * into an empty database, so the seed migration and every append run together and the answer is
 * right whichever of them wrote it. The failure a missing append produces is invisible there and
 * visible only here — an upgraded deployment gets a route nobody can call, silently, and stays
 * that way until somebody edits a Role by hand.
 *
 * So the arrangement is the whole test: apply Core's set as it stood the day before, assert the
 * Role is short of exactly this word, then apply the rest onto it.
 *
 * **Watched failing twice.** With `0048` dropped from the journal the second case named
 * `deployment:read` as the word missing from the upgraded Role, while the first passed — which
 * is the point, since a Role that never gained the permission still holds every one it had. And
 * with the `CASE` taken out of `0048`'s append, the third case named it twice in the same array.
 *
 * Nothing here reaches past the migration seam. The Role is read with SQL because the
 * application cannot boot against a half-migrated database, which is exactly the deployment
 * this migration arrives at.
 */

/** The last migration before the permission — where a deployment stands when `0048` reaches it. */
const BEFORE_THE_PERMISSION = "0047_product_and_variant_media_updated_at_triggers";

/** A database migrated as far as {@link BEFORE_THE_PERMISSION}, and in service. */
async function aDeploymentFromBeforeThePermission(): Promise<TestKobai> {
  const kobai = await createTestKobai({ migrate: false });

  await using asShipped = await migrationSetUpTo(coreMigrationSet, BEFORE_THE_PERMISSION);
  const before = await runMigrations(kobai.db, [asShipped]);
  expect(before.ok, "applying Core's set as it shipped before the permission").toBe(true);

  return kobai;
}

/** What the seeded `owner` Role holds. */
function ownerPermissions(kobai: TestKobai): Promise<{ permissions: string[] }[]> {
  return kobai.database.query<{ permissions: string[] }>(
    `select "permissions" from "core_role" where "name" = 'owner'`,
  );
}

describe("the deployment:read permission arriving at a deployment that already exists", () => {
  it("finds an owner Role that holds every permission but this one", async () => {
    await using kobai = await aDeploymentFromBeforeThePermission();

    // Said out loud, because the whole point is that the append meets a Role that is already
    // there: against a Role seeded with the full list every assertion below would hold of a
    // migration that did nothing at all.
    await expect(ownerPermissions(kobai)).resolves.toEqual([
      {
        permissions: ALL_PERMISSIONS.filter(
          (permission) => permission !== PERMISSIONS.deploymentRead,
        ),
      },
    ]);
  });

  it("appends it to the Role that was already there", async () => {
    await using kobai = await aDeploymentFromBeforeThePermission();

    const upgrade = await runMigrations(kobai.db, [coreMigrationSet]);

    expect(upgrade).toMatchObject({ ok: true });
    // In declaration order, and equal rather than merely containing it: `ALL_PERMISSIONS` is
    // `Object.values` of the literal in `permissions.ts`, so an append that landed anywhere but
    // the end would leave the two lists disagreeing about a set they agree on.
    await expect(ownerPermissions(kobai)).resolves.toEqual([
      { permissions: [...ALL_PERMISSIONS] },
    ]);
  });

  it("leaves an Administrator who added the word by hand holding it once", async () => {
    await using kobai = await aDeploymentFromBeforeThePermission();

    // An Administrator who reads a release note and grants the word ahead of the upgrade —
    // `PATCH /admin/roles/{id}` takes any non-empty string, and Core deliberately does not
    // check the vocabulary. The append is guarded on exactly this, and without the guard the
    // Role comes out of the upgrade holding `deployment:read` twice.
    await kobai.database.query(
      `update "core_role" set "permissions" = "permissions" || ARRAY[$1] where "name" = 'owner'`,
      [PERMISSIONS.deploymentRead],
    );

    await runMigrations(kobai.db, [coreMigrationSet]);

    await expect(ownerPermissions(kobai)).resolves.toEqual([
      { permissions: [...ALL_PERMISSIONS] },
    ]);
  });
});
