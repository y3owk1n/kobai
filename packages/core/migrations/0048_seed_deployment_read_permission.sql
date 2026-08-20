-- The deployment *read* permission, granted to the `owner` Role.
--
-- `GET /admin/openapi.json` and `GET /admin/deployment` are the two routes that answer what this
-- deployment *is* — the version of Core it runs, the Steps filling each Workflow's positions,
-- whether a Payment Provider is wired, and the description of the surface it serves (ADR-0080).
-- They are the first routes on this surface whose subject is the deployment rather than the
-- Store, and they carry a word of their own for exactly that reason.
--
-- Its own word rather than a second use of `store:read`. A Store is the commercial identity —
-- its name, its metadata, its currency — so a Role granted that so somebody could correct a
-- currency would otherwise silently also see which Steps this deployment has replaced. Every
-- other pair on this surface splits on that argument. There is no `deployment:write` beside it
-- and there will not be one: everything these routes read is decided by a file a Developer edits
-- and a process restart, so there is nothing here for a write to gate.
--
-- The same move 0005, 0007, 0008, 0020, 0029, 0030 and 0033 made, for the same reason: a later
-- Core version defines a new permission and adds it to `owner` in its own migration, so an
-- existing deployment's owner keeps holding everything Core defines while a Role that is *not*
-- `owner` gains nothing it was not given. Skip this and every deployment that upgrades gets two
-- routes nobody can call.
--
-- The order matters. `ALL_PERMISSIONS` (src/auth/permissions.ts) is `Object.values` of a
-- literal, so it is that literal's declaration order, and a test asserts this Role's array
-- equals it exactly. Appending in declaration order is what keeps the two agreeing.
--
-- Appended conditionally, so a Role an Administrator granted the word to by hand before the
-- upgrade — `PATCH /admin/roles/{id}` accepts any non-empty string, and Core deliberately does
-- not check the vocabulary — does not come out of this holding it twice.
UPDATE "core_role"
SET "permissions" = "permissions"
  || CASE WHEN "permissions" @> ARRAY['deployment:read']
       THEN ARRAY[]::text[] ELSE ARRAY['deployment:read'] END
WHERE "name" = 'owner';
