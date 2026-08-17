-- The catalog permissions, granted to the `owner` Role.
--
-- 0003 seeded that Role holding every permission Core defined at the time. This is what
-- ADR-0027's note in that file describes happening: a later Core version defines a new
-- permission and adds it to `owner` in its own migration, so an existing deployment's owner
-- keeps holding everything while a Role that is *not* `owner` gains nothing it was not
-- given.
--
-- The order matters. `ALL_PERMISSIONS` (src/auth/permissions.ts) is `Object.values` of a
-- literal, so it is that literal's declaration order, and a test asserts this Role's array
-- equals it exactly. Appending in declaration order is what keeps the two agreeing.
--
-- Appended conditionally, one permission at a time, so re-running against a database that
-- already holds one of them cannot duplicate it.
UPDATE "core_role"
SET "permissions" = "permissions"
  || CASE WHEN "permissions" @> ARRAY['catalog:read']
       THEN ARRAY[]::text[] ELSE ARRAY['catalog:read'] END
  || CASE WHEN "permissions" @> ARRAY['catalog:write']
       THEN ARRAY[]::text[] ELSE ARRAY['catalog:write'] END
WHERE "name" = 'owner';
