-- Every Product that existed before it had an address gets one, derived from its title.
--
-- The middle step of ADR-0038's three, and the only one written by hand: `0036` added
-- `core_product.handle` nullable, this fills it, and `0038` is what makes it `NOT NULL` and
-- unique. drizzle-kit diffs schemas, so a data change is invisible to it in both directions —
-- it will neither write this nor notice it is missing.
--
-- **The uniqueness is why this migration is not a one-line UPDATE** (#119, #153). Postgres
-- refuses `ADD CONSTRAINT … UNIQUE` against a table already holding two rows that agree, and
-- two Products sharing a title is the ordinary case rather than the edge one: `Blue poster`
-- twice is a Merchant who sells two sizes of it. So the constraint in `0038` has to arrive onto
-- data that can already satisfy it, which means **this migration guarantees uniqueness rather
-- than hoping the titles happen to differ**.
--
-- The rule, and it is meant to be defensible rather than clever:
--
--   **Oldest first, each Product takes the handle its title gives it; where that address is
--   already spoken for, it takes the first free `-2`, `-3`, … after it.**
--
-- Three things about that are the decision:
--
-- - **Oldest first, by `(created_at, id)`** — the total order every list in kobai already reads
--   in (ADR-0064), and the one there is an index for. So the assignment is deterministic and
--   the Product that has been in the catalog longest is the one that keeps the plain address,
--   which is the one a Merchant is likeliest to have already linked to. A tie on `created_at`
--   is broken by `id` for the same reason a page's cursor is.
-- - **A number rather than a refusal.** ADR-0038 says a backfill value has to say the fact was
--   never recorded rather than guess at it, and that is exactly what this does: the handle is
--   derived from the title that really was there, and the number says only *which* of the
--   Products with that title this one is. Nothing here invents a fact about a Product. A
--   Merchant who dislikes the number corrects it with `PATCH /admin/products/{id}` — which is a
--   remedy this column being addressable creates, and it is why numbering is the right answer
--   for rows nobody can be asked about, where refusing would be no answer at all.
-- - **The check is against handles already written, not against a count of duplicate titles.**
--   Numbering per title looks equivalent and is not: three Products called `Blue poster` want
--   `blue-poster`, `blue-poster-2` and `blue-poster-3`, and a fourth Product actually *called*
--   "Blue poster 2" wants `blue-poster-2` as its own plain slug. Counting would hand that name
--   out twice and `0038` would then refuse to apply, at the first deployment holding both. So
--   the loop asks what has been taken, which makes the guarantee a property of the algorithm
--   instead of an argument about titles.
--
-- **The slug is derived the way `catalog/handle.ts` derives it**, so a Product from before this
-- column and one created after it are addressed by the same rule: lower-cased, decomposed to
-- NFD, the combining marks that decomposition produced deleted so an accented letter stays one
-- letter, every run of what is left outside `a-z0-9` collapsed to a single `-`, and the `-`s
-- trimmed off both ends. A title that leaves nothing behind — punctuation, or a script that
-- decomposes to none of it — falls back to `product` and takes its place in the numbering, and
-- so does one that would read as a UUID — because `GET /store/products/{idOrHandle}` resolves
-- a UUID as an identifier, and a Product whose handle looked like one would be unreachable by
-- its own address. Those two are refused at creation, where there is a Merchant to ask; a
-- migration has nobody to ask, so it answers rather than failing the deployment.
--
-- `updated_at` advances on every row this writes, which is ADR-0037's trigger doing exactly
-- what it says: the row was written. No migration can recover when a Product last actually
-- changed, and a trigger with a condition on it is how that column went wrong once already.
--
-- Written as a loop rather than as one statement because the guarantee is what is wanted:
-- each Product is handed the first address nothing else has taken, so uniqueness holds by
-- construction and `0038` cannot meet a duplicate. The `WHERE handle IS NULL` and the seeding
-- of the taken set from what is already stored are what make this a *backfill* — run against a
-- table where a Merchant has since chosen handles of their own, it would leave every one of
-- them alone.
DO $$
DECLARE
  product record;
  base text;
  candidate text;
  suffix int;
BEGIN
  -- The addresses already spoken for, in something that can be asked cheaply. A `SELECT` back
  -- over `core_product` would answer the same question and scan the table once per Product,
  -- because the index that makes a handle findable does not exist until `0038`.
  CREATE TEMP TABLE backfilled_product_handles (handle text PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO backfilled_product_handles ("handle")
    SELECT "handle" FROM "core_product" WHERE "handle" IS NOT NULL;

  FOR product IN
    SELECT "id", "title" FROM "core_product" WHERE "handle" IS NULL ORDER BY "created_at", "id"
  LOOP
    -- The same five steps `slugify` takes, in the same order: lower-cased, decomposed to NFD,
    -- the combining marks NFD produced **deleted** rather than collapsed — so `Café Crème`
    -- becomes `cafe-creme` and not `cafe-cre-me` — every run of what is left outside `a-z0-9`
    -- collapsed to one `-`, and the hyphens trimmed off both ends. `U+0300`–`U+036F` is written
    -- out as a range because Postgres has no `\p{M}`, which is why TypeScript does not use one
    -- either: a class only one of the two can express is a rule they quietly disagree about.
    base := trim(
      both '-' from
      regexp_replace(
        regexp_replace(normalize(lower(product.title), NFD), '[̀-ͯ]', '', 'g'),
        '[^a-z0-9]+',
        '-',
        'g'
      )
    );

    IF base = '' OR base ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      base := 'product';
    END IF;

    candidate := base;
    suffix := 1;
    WHILE EXISTS (SELECT 1 FROM backfilled_product_handles WHERE "handle" = candidate) LOOP
      suffix := suffix + 1;
      candidate := base || '-' || suffix;
    END LOOP;

    INSERT INTO backfilled_product_handles ("handle") VALUES (candidate);
    UPDATE "core_product" SET "handle" = candidate WHERE "id" = product.id;
  END LOOP;
END $$;
