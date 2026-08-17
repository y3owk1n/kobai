-- The API key permissions, granted to the `owner` Role.
--
-- The same move 0005 made for the catalog, for the same reason: a later Core version defines
-- a new permission and adds it to `owner` in its own migration, so an existing deployment's
-- owner keeps holding everything Core defines while a Role that is *not* `owner` gains
-- nothing it was not given (ADR-0027).
--
-- The order matters. `ALL_PERMISSIONS` (src/auth/permissions.ts) is `Object.values` of a
-- literal, so it is that literal's declaration order, and a test asserts this Role's array
-- equals it exactly. Appending in declaration order is what keeps the two agreeing.
--
-- Appended conditionally, one permission at a time, so re-running against a database that
-- already holds one of them cannot duplicate it.
UPDATE "core_role"
SET "permissions" = "permissions"
  || CASE WHEN "permissions" @> ARRAY['api-key:read']
       THEN ARRAY[]::text[] ELSE ARRAY['api-key:read'] END
  || CASE WHEN "permissions" @> ARRAY['api-key:write']
       THEN ARRAY[]::text[] ELSE ARRAY['api-key:write'] END
WHERE "name" = 'owner';
