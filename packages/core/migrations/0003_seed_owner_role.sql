-- The `owner` Role — the one a deployment's first Merchant claims it with.
--
-- Seeded here rather than created at boot for the same reason the Store is (0001): a
-- deployment with no Role at all cannot have a Merchant, so an empty `core_role` is not a
-- state anything should have to handle. There is exactly one Role, holding every permission
-- Core defines. Further Roles — a narrower one for a team — are rows a later ticket adds.
--
-- The permission list here is Core's `ALL_PERMISSIONS` (src/auth/permissions.ts), and a test
-- asserts the two agree. A later Core version that defines a new permission adds it to this
-- Role in its own migration, so an existing deployment's owner keeps holding everything.
INSERT INTO "core_role" ("name", "permissions")
VALUES ('owner', ARRAY['store:read', 'merchant:write'])
ON CONFLICT ("name") DO NOTHING;
