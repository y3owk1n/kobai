-- The Order *read* permission, granted to the `owner` Role.
--
-- The books are their own power. A colleague who maintains the catalog holds `catalog:read`
-- and has no business reading what every Shopper paid and who they are, so listing and
-- opening an Order names a permission of its own rather than a second use of an existing one
-- (ADR-0027 — a named Permission on a Role, never a rule about which Orders). There is no
-- `order:write` beside it: an Order is immutable (ADR-0009), so there is nothing to gate.
--
-- The same move 0005, 0007 and 0008 made, for the same reason: a later Core version defines a
-- new permission and adds it to `owner` in its own migration, so an existing deployment's
-- owner keeps holding everything Core defines while a Role that is *not* `owner` gains
-- nothing it was not given.
--
-- The order matters. `ALL_PERMISSIONS` (src/auth/permissions.ts) is `Object.values` of a
-- literal, so it is that literal's declaration order, and a test asserts this Role's array
-- equals it exactly. Appending in declaration order is what keeps the two agreeing.
--
-- Appended conditionally, so re-running against a database that already holds it cannot
-- duplicate it.
UPDATE "core_role"
SET "permissions" = "permissions"
  || CASE WHEN "permissions" @> ARRAY['order:read']
       THEN ARRAY[]::text[] ELSE ARRAY['order:read'] END
WHERE "name" = 'owner';
