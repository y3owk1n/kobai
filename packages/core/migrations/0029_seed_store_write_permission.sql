-- The Store *write* permission, granted to the `owner` Role.
--
-- `PATCH /admin/store` is the first route that changes the Store, and reading what a
-- deployment is called and changing it are different powers — the split `catalog:read` and
-- `catalog:write` already draw, and `api-key:read` and `api-key:write` beside them (ADR-0027 —
-- a named Permission on a Role, never a rule about which rows). Which gate a route sits behind
-- is promised surface (ADR-0060), so gating this write behind `store:read` would have been a
-- break to undo later rather than a decision taken now.
--
-- The same move 0005, 0007, 0008 and 0020 made, for the same reason: a later Core version
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
  || CASE WHEN "permissions" @> ARRAY['store:write']
       THEN ARRAY[]::text[] ELSE ARRAY['store:write'] END
WHERE "name" = 'owner';
