-- The Cart *read* permission, granted to the `owner` Role.
--
-- `GET /admin/carts` and `GET /admin/carts/{id}` are the first routes that enumerate Carts, and
-- they reverse a rule Core had written down: `core_cart`'s schema comment used to say there was
-- deliberately no route that lists them, so there was nothing to enumerate. The amended rule is
-- that a Cart identifier is a capability Merchants hold and the public does not (ADR-0071), and
-- the comment moved in the same change as the routes.
--
-- Its own word rather than a second use of `order:read`. ADR-0009's first decision is that a
-- Cart and an Order are governed by opposite rules — one is expected to change and be thrown
-- away, the other must never change again — so merging their Permissions would say the opposite
-- in the one place a deployment configures trust. `catalog:read` was worse still: a Role granted
-- so somebody could edit Products would then include every Shopper's basket. There is no
-- `cart:write` beside this one yet: everything this Permission opens is read-only, and editing a
-- Cart on a Merchant's behalf is decided but belongs to a later spec, which will bring its own
-- word and its own migration. Releasing a hold never arrives — doing it by hand takes stock from
-- a Shopper who may be mid-payment at their bank (ADR-0070).
--
-- The same move 0005, 0007, 0008, 0020, 0029 and 0030 made, for the same reason: a later Core
-- version defines a new permission and adds it to `owner` in its own migration, so an existing
-- deployment's owner keeps holding everything Core defines while a Role that is *not* `owner`
-- gains nothing it was not given. Skip this and every deployment that upgrades gets two routes
-- nobody can call.
--
-- The order matters. `ALL_PERMISSIONS` (src/auth/permissions.ts) is `Object.values` of a
-- literal, so it is that literal's declaration order, and a test asserts this Role's array
-- equals it exactly. Appending in declaration order is what keeps the two agreeing.
--
-- Appended conditionally, so re-running against a database that already holds it cannot
-- duplicate it.
UPDATE "core_role"
SET "permissions" = "permissions"
  || CASE WHEN "permissions" @> ARRAY['cart:read']
       THEN ARRAY[]::text[] ELSE ARRAY['cart:read'] END
WHERE "name" = 'owner';
