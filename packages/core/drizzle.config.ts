// Core's migration config. A Plugin's is the same call with its own four values — see
// `defineKobaiDrizzleConfig`, which is exported as `@kobai/core/migrations` precisely so
// there is one implementation of this shape rather than a documented convention.
//
// There is deliberately no `push` command anywhere in kobai. See the `// db:push` note in
// this package's package.json, and docs/adr/0030.
import { defineKobaiDrizzleConfig } from "./src/migrations/drizzle-config.ts";

export default defineKobaiDrizzleConfig({
  package: "core",
  tablePrefix: "core",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
