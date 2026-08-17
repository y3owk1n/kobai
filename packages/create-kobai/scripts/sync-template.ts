import { fileURLToPath } from "node:url";
import { syncTemplate } from "../src/template.ts";

/**
 * `devbox run template:generate` — rewrites `template/` from the reference Project.
 *
 * The reference Project is the source of truth and this is the one command that carries a
 * change in it through to what `create-kobai` generates. Forgetting to run it is not a
 * silent failure: `tests/create-kobai-matches-the-reference-project.test.ts` regenerates the
 * template in memory and fails the build when it does not match what is checked in, naming
 * every file that differs.
 */
const packageRoot = new URL("../", import.meta.url);

const files = await syncTemplate({
  referenceRoot: fileURLToPath(new URL("../../reference/", packageRoot)),
  templateRoot: fileURLToPath(new URL("template/", packageRoot)),
  standaloneRoot: fileURLToPath(new URL("standalone/", packageRoot)),
  rootManifest: fileURLToPath(new URL("../../package.json", packageRoot)),
});

process.stdout.write(
  `Wrote ${files.length} template files from the reference Project.\n`,
);
