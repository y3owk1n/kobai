-- `updated_at` advances on every UPDATE of every Core row, whoever writes it.
--
-- Until this migration the column defaulted to `now()` and nothing ever moved it, so on any
-- row written twice it was not stale but wrong — and wrong in the shape of a correct answer.
-- The mechanism is a trigger rather than Drizzle's `$onUpdate` because under ADR-0004 the
-- writers Core does not mediate are the normal case, not the exception: a Project owns its
-- repository and its migrations, a Plugin owns its tables, and neither is obliged to go
-- through Core's query builder. See ADR-0037 for the argument in full.
--
-- Hand-written, in a `--custom` migration, because drizzle-kit's schema model has no trigger
-- in it: `generate` will neither emit this nor, afterwards, notice it. The journal entry was
-- generated like every other, never edited. This migration only repairs the *rule* — the
-- rows already written carry a `updated_at` equal to their `created_at` and no migration can
-- recover when they actually changed.
CREATE OR REPLACE FUNCTION core_set_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- Unconditional: every UPDATE advances the column, including one that sets it explicitly
  -- and one that writes a row's existing values back. "The row was written" is a promise a
  -- reader can hold without qualification, which is the point of picking it over the
  -- `WHEN (OLD.* IS DISTINCT FROM NEW.*)` variant that would make it mean "and something
  -- changed". A column whose advance has a condition on it is how this went wrong once.
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Attached by sweeping the schema, not by naming seven tables: the rule is stated once, and
-- a table that carries the column cannot be given a different one by accident. Future Core
-- tables are the omission this cannot close on its own — `updated-at.test.ts` is the
-- guardrail that catches one, by asking Postgres for every `core_` table carrying the column
-- and failing on any without the trigger.
--
-- `starts_with` rather than a `LIKE` pattern, because the underscore in `core_` is a LIKE
-- wildcard and an escape that is right only while `standard_conforming_strings` is on is a
-- worse way to say the same thing. `current_schema()` because that is where the CREATE TABLE
-- statements in the migrations before this one put the tables.
--
-- `BASE TABLE` because `information_schema.columns` describes views too, and a row-level
-- BEFORE trigger cannot go on one — a future `core_` view carrying `updated_at` would fail
-- this migration outright. It is also the same question the guardrail asks, which matters:
-- `inspectSchema.tables()` filters on exactly this, so a sweep that did not would attach
-- triggers the guardrail never looks for, or look for triggers the sweep could never attach.
DO $$
DECLARE
  target text;
  trigger_name text;
BEGIN
  FOR target IN
    SELECT column_.table_name
    FROM information_schema.columns column_
    JOIN information_schema.tables table_
      ON table_.table_schema = column_.table_schema
     AND table_.table_name = column_.table_name
    WHERE column_.table_schema = current_schema()
      AND column_.column_name = 'updated_at'
      AND starts_with(column_.table_name, 'core_')
      AND table_.table_type = 'BASE TABLE'
    ORDER BY column_.table_name
  LOOP
    trigger_name := target || '_set_updated_at';

    -- Postgres truncates an identifier at 63 bytes silently, and a truncated trigger name is
    -- one the guardrail can never find — a permanently red test blaming the wrong thing.
    -- Refusing here is the loud failure instead, and `migrationsTableFor` in
    -- `src/migrations/set.ts` refuses the same class for the same reason.
    IF octet_length(trigger_name) > 63 THEN
      RAISE EXCEPTION
        'Table "%" is too long to carry an updated_at trigger: "%" exceeds Postgres''s 63-byte identifier limit and would be truncated out of the guardrail''s reach.',
        target, trigger_name;
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', trigger_name, target);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION core_set_updated_at()',
      trigger_name,
      target
    );
  END LOOP;
END $$;
