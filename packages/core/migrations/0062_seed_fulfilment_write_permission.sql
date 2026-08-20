-- The permission that moves a Fulfilment, granted to the `owner` Role.
--
-- `fulfilment:write` gates the three routes that dispatch, deliver and cancel one Fulfilment of
-- an Order (#320). Its own word rather than a second use of `order:read` because they are
-- different powers: reading what every Shopper paid and posting a parcel are not the same job,
-- and warehouse staff should be able to do the second and not the first (story 16 of #211).
--
-- **There is no `fulfilment:read` beside it**, and that is a decision rather than half a pair. A
-- Fulfilment is not addressable on its own — it is read *through* its Order, on the shape both
-- `GET /admin/orders/{id}` and `GET /store/orders/{id}` already answer with — so there is no
-- route for a read permission to gate, and the house rule adds one when a route needs it rather
-- than for symmetry.
--
-- The same move 0005, 0007, 0008, 0020, 0029, 0030, 0033 and 0048 made, for the same reason: a
-- later Core version defines a new permission and adds it to `owner` in its own migration, so an
-- existing deployment's owner keeps holding everything Core defines while a Role that is *not*
-- `owner` gains nothing it was not given. Skip this and every deployment that upgrades gets three
-- routes nobody can call.
--
-- The order matters. `ALL_PERMISSIONS` (src/auth/permissions.ts) is `Object.values` of a literal,
-- so it is that literal's declaration order, and a test asserts this Role's array equals it
-- exactly. Appending in declaration order is what keeps the two agreeing.
--
-- Appended conditionally, so re-running against a database that already holds it — an
-- Administrator who read a release note and granted the word ahead of the upgrade — cannot
-- duplicate it.
UPDATE "core_role"
SET "permissions" = "permissions"
  || CASE WHEN "permissions" @> ARRAY['fulfilment:write']
       THEN ARRAY[]::text[] ELSE ARRAY['fulfilment:write'] END
WHERE "name" = 'owner';
