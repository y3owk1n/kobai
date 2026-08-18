-- The Merchant *read* permission, granted to the `owner` Role.
--
-- `merchant:write` is the power to administer access entire — a Merchant who may add a
-- colleague may add one against `owner` and sign in as them — which is why there is no
-- `role:write` beside it and why every write on that surface sits behind the one word
-- (ADR-0066). That argument reaches the writes and stops there: seeing who has access confers
-- nothing, and without this Permission the only way to let somebody see the team would be to
-- give them the power to change it. `GET /admin/roles`, `GET /admin/roles/{id}` and
-- `GET /admin/merchants` sit behind this one, which is the split `catalog:read`/`catalog:write`,
-- `api-key:read`/`api-key:write` and `store:read`/`store:write` already draw. Which gate a
-- route sits behind is promised surface (ADR-0060), so this is a decision taken now rather than
-- a break to undo later.
--
-- The same move 0005, 0007, 0008, 0020 and 0029 made, for the same reason: a later Core version
-- defines a new permission and adds it to `owner` in its own migration, so an existing
-- deployment's owner keeps holding everything Core defines while a Role that is *not* `owner`
-- gains nothing it was not given.
--
-- The order matters. `ALL_PERMISSIONS` (src/auth/permissions.ts) is `Object.values` of a
-- literal, so it is that literal's declaration order, and a test asserts this Role's array
-- equals it exactly. Appending in declaration order is what keeps the two agreeing.
--
-- Appended conditionally, so re-running against a database that already holds it cannot
-- duplicate it.
UPDATE "core_role"
SET "permissions" = "permissions"
  || CASE WHEN "permissions" @> ARRAY['merchant:read']
       THEN ARRAY[]::text[] ELSE ARRAY['merchant:read'] END
WHERE "name" = 'owner';
