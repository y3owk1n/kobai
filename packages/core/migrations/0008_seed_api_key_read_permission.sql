-- The API key *read* permission, granted to the `owner` Role.
--
-- #6 shipped minting and revocation and no way to enumerate keys, so a Merchant who lost the
-- creation response held a live credential they could not name. Listing is its own
-- permission rather than a second use of `api-key:write`, because seeing which credentials
-- exist and handing out a new one are different powers — and the route names exactly one.
--
-- The same move 0005 and 0007 made, for the same reason: a later Core version defines a new
-- permission and adds it to `owner` in its own migration, so an existing deployment's owner
-- keeps holding everything Core defines while a Role that is *not* `owner` gains nothing it
-- was not given (ADR-0027).
--
-- The order matters. `ALL_PERMISSIONS` (src/auth/permissions.ts) is `Object.values` of a
-- literal, so it is that literal's declaration order, and a test asserts this Role's array
-- equals it exactly. Appending in declaration order is what keeps the two agreeing.
--
-- Appended conditionally, so re-running against a database that already holds it cannot
-- duplicate it.
UPDATE "core_role"
SET "permissions" = "permissions"
  || CASE WHEN "permissions" @> ARRAY['api-key:read']
       THEN ARRAY[]::text[] ELSE ARRAY['api-key:read'] END
WHERE "name" = 'owner';
