#!/usr/bin/env bash
# PROTOTYPE — throwaway. Answers the ADR-0011 open risk. See README.md.
set -uo pipefail
cd "$(dirname "$0")"

export DATABASE_URL="postgres://prototype:prototype@localhost:55432/kobai_prototype_wipe_me"
PKGS=(core plugin-reviews plugin-wishlist)

hr() { printf '\n\033[1;36m━━ %s\033[0m\n' "$*"; }
note() { printf '\033[2m   %s\033[0m\n' "$*"; }

cleanup() {
  [ -f packages/plugin-reviews/schema.ts.orig ] &&
    mv packages/plugin-reviews/schema.ts.orig packages/plugin-reviews/schema.ts
  docker compose down -v >/dev/null 2>&1
  printf '\n\033[2m   disposable postgres torn down.\033[0m\n'
}
trap cleanup EXIT

hr "SETUP · deps + disposable postgres"
pnpm install --silent 2>&1 | tail -2
docker compose down -v >/dev/null 2>&1
docker compose up -d --wait 2>&1 | tail -2

# ── A ────────────────────────────────────────────────────────────────────────
hr "A · can each package generate migrations independently?"
note "Each runs drizzle-kit with only its own config. None can see the others."
for p in "${PKGS[@]}"; do
  rm -rf "packages/$p/migrations"
  pnpm exec drizzle-kit generate --config="packages/$p/drizzle.config.ts" 2>&1 |
    sed 's/^/   /' | grep -Ev '^\s*$' | tail -4
done

echo
note "generated SQL — does any package emit tables it does not own?"
for p in "${PKGS[@]}"; do
  echo "   $p:"
  grep -ho 'CREATE TABLE [^ ]*' "packages/$p/migrations"/*.sql | sed 's/^/     /'
done

# ── B + C ────────────────────────────────────────────────────────────────────
hr "B+C · apply in the WRONG order — plugins before core"
note "A Project installs plugins in whatever order it likes. Core goes last on purpose."
for p in plugin-reviews plugin-wishlist core; do
  pnpm exec tsx scripts/migrate.ts "$p" || echo "   FAILED: $p"
done

hr "state of the database"
pnpm exec tsx scripts/inspect.ts

# ── D ────────────────────────────────────────────────────────────────────────
hr "D · evolve ONE package — does it disturb the others?"
note "reviews gains a column. core and wishlist are not touched, not regenerated."
cp packages/plugin-reviews/schema.ts packages/plugin-reviews/schema.ts.orig
cp packages/plugin-reviews/schema.v2.ts packages/plugin-reviews/schema.ts
pnpm exec drizzle-kit generate --config=packages/plugin-reviews/drizzle.config.ts 2>&1 |
  sed 's/^/   /' | grep -Ev '^\s*$' | tail -3
pnpm exec tsx scripts/migrate.ts plugin-reviews || echo "   FAILED"
mv packages/plugin-reviews/schema.ts.orig packages/plugin-reviews/schema.ts

hr "state after evolving reviews only"
note "expect: reviews = 2 migrations, core and wishlist = 1 each, untouched."
pnpm exec tsx scripts/inspect.ts

# ── E ────────────────────────────────────────────────────────────────────────
hr "E · the footgun — is 'drizzle-kit push' safe here?"
note "push diffs the SCHEMA against the LIVE DATABASE, unlike generate. Run last:"
note "if it is unsafe, it destroys the database, and nothing after it would be valid."

echo
echo "   E1 · push WITH tablesFilter: ['core_*']"
pnpm exec drizzle-kit push --config=packages/core/drizzle.config.ts --force 2>&1 |
  sed 's/^/     /' | tail -12
echo
note "did the plugin tables survive a filtered push?"
pnpm exec tsx scripts/inspect.ts

echo
echo "   E2 · push WITHOUT tablesFilter (the control case)"
pnpm exec drizzle-kit push --config=packages/core/drizzle.config.unsafe.ts --force 2>&1 |
  sed 's/^/     /' | tail -20
echo
note "and now?"
pnpm exec tsx scripts/inspect.ts

hr "done — read the output above, then write FINDINGS.md"
