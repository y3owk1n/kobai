// This Plugin's migration config — the same `defineKobaiDrizzleConfig` call Core makes,
// with this package's own four values. A Plugin author writes exactly this much.
//
// There is deliberately no `push` command anywhere in kobai. See the `// db:push` note in
// this package's package.json, and docs/adr/0030.
import { defineKobaiDrizzleConfig } from "@kobai/core/migrations";

export default defineKobaiDrizzleConfig({
  package: "plugin-made-to-order",
  tablePrefix: "made_to_order",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
