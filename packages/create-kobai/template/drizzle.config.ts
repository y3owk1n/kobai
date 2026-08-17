// This Project's migration config — the same `defineKobaiDrizzleConfig` call Core makes and
// every Plugin makes, with this Project's own four values. A Project owns tables on exactly
// the same terms a Plugin does, through exactly the same machinery, which is what makes
// "add a column to your own table" a thing a Developer can actually do rather than a thing
// the documentation claims.
//
// There is deliberately no `push` command anywhere in kobai. See the `// db:push` note in
// this Project's package.json, and docs/adr/0030.
import { defineKobaiDrizzleConfig } from "@kobai/core/migrations";

export default defineKobaiDrizzleConfig({
  // `project`, not this Project's npm name. A Project is a singleton in its own database —
  // there is exactly one, and it never has to be told apart from another the way two
  // installed Plugins do — so a fixed name keeps every kobai Project's tracking table at
  // `__drizzle_migrations_project`, and keeps what `create-kobai` generates identical to
  // the reference Project rather than differing by whatever the Developer typed.
  package: "project",
  tablePrefix: "project",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
